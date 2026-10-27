# Greybox command language

One line per change. The scene agent writes it, `greybox.run()` in the browser console accepts it,
**File > Open** loads `.txt` scripts written in it, and every render pack includes the scene in it
(`scene.greybox.txt`). A block of commands is applied as one undo step, and nothing changes if any
line fails.

## World

- Metres, Y up, ground at `y = 0`.
- Object pivots are bottom-centre: `at=x,0,z` stands on the ground. Two numbers (`at=2,5`) mean
  `x,z` on the ground.
- People and objects face +Z. `yaw=90` faces +X.
- Around a subject: angle `0` is in front of it, `90` is its left side, `180` is behind it.
- Cameras aim at a point or follow an object id.

## Commands

```
add <type> <id> [at=x,y,z] [yaw=deg | rot=x,y,z] [size=w,h,d] [scale=...] [desc="..."] [name="..."]
                [role=set|prop|character] [parent=<group>] [color=#hex] [face=<id|cam|x,y,z>]
    mannequin only: height=<m> pose=<name> look=cam|<id>|none
set <id> <same properties>
del <id>                         children are deleted too
parent <id> <group|none>
key <id> <channel> t=<s> <value> [e=<ease>] ; t=<s> <value> ...
clear <id> [channel|all]
cam <id> [at=x,y,z] [look=<id|x,y,z>] [lens=<mm> | fov=<deg>] [roll=deg] [shake=0..1] [name="..."]
cut t=<s> <camera> ; t=<s> <camera>     cut clear
light <sun|point|spot> <id> [at=x,y,z] [look=x,y,z] [intensity=n] [color=#hex]
duration <s>    fps <n>    size <W>x<H>    bg #hex
name "..."      look "<visual style>"      audio "<sound>"
ref <slot> <id|location|style> "what the image shows"      ref clear
macro <name> key=value ...
```

**Types.** `box sphere cylinder cone plane capsule mannequin group glb` plus kits with recognisable
silhouettes: `car truck tree building table chair sofa bed door wall lamp stairs window`.

**Poses.** `stand walk run sit talk wave point crouch lie`. A pose key cross-fades over 0.35 s.

**Channels.** Objects: `pos rot yaw scale pose look`. Cameras: `pos target lens fov roll`.
`look` on a camera means `target`.

**Eases.** `linear inout in out step smooth`. The ease applies to the segment that ends at the key.
`smooth` passes a Catmull-Rom curve through the keys with linear timing; macros use it for orbits.

## Macros

| Macro | Purpose |
| --- | --- |
| `frame cam= target= size= angle= height= [lens=] [t=]` | Place a camera so the subject fills the frame. `size`: `ecu closeup mcu medium cowboy full wide extreme_wide`. `height`: `eye low high overhead` or metres. |
| `orbit cam= target= from= to= [radius= or size=] [height=] [t0 t1] [e]` | Circle a subject; follows it if it moves. |
| `push cam= target= from= to= [angle=] [t0 t1] [e]` | Dolly in or out. `from`/`to` take framing names or metres. |
| `crane cam= target= from=<m> to=<m> [dist= or size=] [angle=]` | Rise or descend while holding the subject. |
| `follow cam= target= [angle=180] [dist= or size=] [height=]` | Travel with a moving subject. `180` trails it, `0` leads it. |
| `pan cam= from=<id or point> to=<id or point>` | Camera stays put and turns. |
| `move cam= to=x,y,z [from=] [look=]` | Straight camera move. |
| `zoom cam= from=<mm> to=<mm>` | Change focal length over time. |
| `walk who= path=x,z\|x,z\|... [pose=walk\|run] [end=<pose>]` | Walk through ground points, turning to face the direction of travel. |
| `room id= [w= d= h=] [door=front\|back\|left\|right\|none]` | Floor and four walls; front is +Z. |
| `street id= [length= width=] [buildings=yes\|no] [lamps=yes\|no] [seed=]` | Road along Z with pavements, buildings and lamps. |
| `crowd id= count= [area=w,d] [pose=] [look=] [seed=]` | Background people. |

`t0` and `t1` default to the whole shot. `e` defaults to `inout`.

## Example

```
duration 8
look "night, rain, neon reflections, anamorphic"
add mannequin ana at=-4,0,2 yaw=90 desc="a woman in a long camel coat"
add car car1 at=2,0,0 desc="a black 1970s sedan"
macro walk who=ana path=1,1.6 t0=0 t1=4.5
macro follow cam=cam1 target=ana angle=150 size=full t0=0 t1=4.5
cam cam2 lens=50
macro frame cam=cam2 target=ana size=closeup angle=30
cut t=0 cam1 ; t=4.5 cam2
ref 1 ana "her face and coat"
```
