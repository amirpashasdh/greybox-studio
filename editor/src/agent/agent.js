// The scene agent: language model writes Greybox commands, code applies and checks them.
// Failed lines and lint errors go back to the model once or twice; geometry never comes from the model.

import {
  applyCommands, extractCommands, docToCommands, lintScene, formatIssues, macroHelp, TYPES, POSES, KITS, round,
} from '../core/index.js';
import { chat } from './llm.js';

const COMMANDS = `
add <type> <id> [at=x,y,z] [yaw=deg | rot=x,y,z] [size=w,h,d] [desc="..."] [name="..."] [role=set|prop|character] [parent=<group id>] [color=#hex]
    types: ${TYPES.join(', ')}
    mannequin extras: height=<m> pose=<${POSES.join('|')}> look=cam|<id>|none
    face=<id|cam|x,y,z> turns the new object to face something
set <id> <same properties as add>        change an object, camera or light
del <id>                                 delete (children go too)
key <id> <channel> t=<s> <value> [e=linear|inout|in|out|step|smooth] ; t=<s> <value> ...
    object channels: pos (x,y,z), rot (x,y,z), yaw (deg), scale, pose (name), look (cam|id|none)
    camera channels: pos, target (x,y,z or object id), lens (mm), roll
clear <id> [channel|all]                 remove animation
cam <id> [at=x,y,z] [look=<id|x,y,z>] [lens=<mm>] [roll=deg] [shake=0..1] [name="..."]   create or change a camera
cut t=<s> <camId> ; t=<s> <camId>        which camera is live from that time
light <sun|point|spot> <id> [at=x,y,z] [look=x,y,z] [intensity=n]
duration <s> | fps <n> | size <W>x<H> | name "..." | look "<visual style>" | audio "<sound>"
ref <slot> <id|location|style> "what the reference image shows"`.trim();

export function systemPrompt(doc, { time = 0, selection = null, mode = 'apply' } = {}) {
  const issues = lintScene(doc);
  return `You are the blocking assistant in Greybox, a previsualisation editor. You build and change 3D blockout scenes by writing Greybox commands. The scene is rendered to depth, pose and mask videos that steer a video model, so placement, scale, timing and camera work matter. Surface materials do not.

WORLD
- Metres, Y is up, the ground is y=0. Object pivots are bottom-centre: at=x,0,z stands on the ground.
- People and objects face +Z. yaw=90 turns them to face +X, yaw=180 faces -Z.
- A person (mannequin) is about 1.75 m tall; a doorway is 2.1 m; a car is 4.4 m long.
- Around a subject, angle 0 is in front of it, 90 is its left side, 180 is behind it.

HOW TO REPLY
- One short sentence about what you are doing, then exactly one fenced block: \`\`\`greybox ... \`\`\`
- Change only what was asked. The current scene is listed below; reuse its ids.
- Use macros for framing, camera moves, walking, rooms, streets and crowds. Do not compute coordinates a macro can compute.
- Give every person a desc= saying who they are and what they wear; it becomes the video prompt. Describe props and set pieces the same way.
- Prefer kit types (car, tree, building, door, lamp, ...) over plain boxes so silhouettes read in the depth pass.
- Keep all keys and cuts within the shot duration. Use look=cam when someone speaks to camera.
- If something is ambiguous, choose sensibly and say what you chose.${mode === 'ask' ? '\n- ASK MODE: answer the question in plain words. Do not write commands.' : ''}

COMMANDS
${COMMANDS}

MACROS
${macroHelp()}

EXAMPLE
User: a woman walks to a parked car while the camera follows her, then a close-up as she opens the door
Reply: Blocking her walk to the car with a follow shot, then a cut to a close-up.
\`\`\`greybox
duration 8
add mannequin ana at=-4,0,2 desc="a woman in her 30s in a long camel coat" yaw=90
add car car1 at=2,0,0 desc="a black 1970s sedan"
macro walk who=ana path=1,1.6 t0=0 t1=4.5
macro follow cam=cam1 target=ana angle=150 size=full t0=0 t1=4.5
cam cam2 lens=50
macro frame cam=cam2 target=ana size=closeup angle=30
key ana pose t=4.6 point
cut t=0 cam1 ; t=4.5 cam2
\`\`\`

CURRENT SCENE (playhead at ${round(time, 2)} s${selection ? `, selected: ${selection}` : ''})
\`\`\`greybox
${docToCommands(doc, { maxKeys: 6 })}
\`\`\`
${issues.length ? `\nCURRENT ISSUES\n${formatIssues(issues)}` : ''}`;
}

// One agent turn. Returns { text, commands, doc, errors, issues, applied }.
export async function runAgent({ doc, history, userText, settings, time, selection, onStream, signal }) {
  const mode = settings.agentMode || 'apply';
  const base = [{ role: 'system', content: systemPrompt(doc, { time, selection, mode }) }, ...history.slice(-8)];
  const messages = [...base, { role: 'user', content: userText }];
  let reply = await chat({ settings, messages, onDelta: (_, full) => onStream?.(full), signal });
  if (mode === 'ask') return { text: reply, commands: '', doc, errors: [], issues: [], applied: false };

  let commands = extractCommands(reply);
  if (!commands) return { text: reply, commands: '', doc, errors: [], issues: [], applied: false };

  // Up to two repair rounds for lines that fail to parse or apply.
  let result = applyCommands(doc, commands);
  for (let attempt = 0; attempt < 2 && result.errors.length; attempt++) {
    onStream?.(`${reply}\n\n(fixing ${result.errors.length} line${result.errors.length > 1 ? 's' : ''}...)`);
    const errs = result.errors.map((e) => `line ${e.line}: ${e.text}\n  -> ${e.msg}`).join('\n');
    const repair = [...messages, { role: 'assistant', content: reply }, {
      role: 'user',
      content: `Some commands failed, so nothing was applied:\n${errs}\nSend the whole corrected block.`,
    }];
    reply = await chat({ settings, messages: repair, signal, temperature: 0.1 });
    commands = extractCommands(reply) || commands;
    result = applyCommands(doc, commands);
  }
  if (result.errors.length) {
    return { text: reply, commands, doc, errors: result.errors, issues: [], applied: false };
  }

  // One round to fix scene problems the edit introduced (camera in a wall, person under the floor).
  const before = new Set(lintScene(doc).map((i) => i.msg));
  let issues = lintScene(result.doc).filter((i) => i.level === 'error' && !before.has(i.msg));
  if (issues.length) {
    onStream?.(`${reply}\n\n(checking the blocking...)`);
    const fix = [...messages, { role: 'assistant', content: reply }, {
      role: 'user',
      content: `Applied, but the scene now has problems:\n${formatIssues(issues)}\nScene after your edit:\n\`\`\`greybox\n${docToCommands(result.doc, { maxKeys: 6 })}\n\`\`\`\nSend only the extra commands that fix these problems.`,
    }];
    const fixReply = await chat({ settings, messages: fix, signal, temperature: 0.1 });
    const fixCmds = extractCommands(fixReply);
    if (fixCmds) {
      const fixed = applyCommands(result.doc, fixCmds);
      if (!fixed.errors.length) {
        result = fixed;
        commands = `${commands}\n# fixes\n${fixCmds}`;
      }
    }
    issues = lintScene(result.doc).filter((i) => !before.has(i.msg));
  } else {
    issues = lintScene(result.doc).filter((i) => !before.has(i.msg));
  }
  const text = reply.replace(/```[\s\S]*?```/g, '').trim();
  return { text, commands, doc: result.doc, errors: [], issues, applied: true };
}

export const KIT_NAMES = Object.keys(KITS);
