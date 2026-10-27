// Example shots, written in the same command language the agent uses.

export const EXAMPLES = [
  {
    name: 'Subway verse',
    blurb: 'One continuous 360-degree orbit; the performer turns his head to keep eyes on the lens.',
    script: `
name "Subway verse"
duration 8
fps 24
size 1280x720
look "night, an empty moving subway car, cool fluorescent light, photoreal, clean digital image"
audio "train rumble and rail clacks under one voice rapping slowly, no music"
add box car.floor size=3,0.02,14 desc="the subway car floor" role=set
add box car.benchL at=-1.25,0,0 size=0.5,0.45,9 desc="a moulded plastic bench seat"
add box car.benchR at=1.25,0,0 size=0.5,0.45,9 desc="a moulded plastic bench seat"
add box car.wallL at=-1.55,0,0 size=0.1,2.3,14 desc="the car wall with black windows" role=set
add box car.wallR at=1.55,0,0 size=0.1,2.3,14 desc="the car wall with black windows" role=set
add cylinder pole1 at=-0.65,0,1.1 size=0.05,2.3,0.05 desc="a steel grab pole"
add cylinder pole2 at=0.65,0,-1.4 size=0.05,2.3,0.05 desc="a steel grab pole"
add mannequin rapper desc="a hooded young rapper in layered streetwear" pose=talk look=cam
set cam1 lens=35
macro orbit cam=cam1 target=rapper size=mcu from=30 to=390 t0=0 t1=8 e=linear
ref 1 rapper "face, hood and full outfit"
ref 2 location "empty subway car interior"
`,
  },
  {
    name: 'Office call',
    blurb: 'A man paces while on the phone; slow push from a full shot to a close-up.',
    script: `
name "Office call"
duration 10
look "late afternoon office, warm low sun through blinds, shallow depth of field, 35mm film"
audio "muffled city outside, one side of a tense phone call"
macro room id=office w=6 d=7 h=3 door=back
add table desk at=0,0,-1.8 desc="a cluttered wooden desk" parent=office
add chair chair1 at=0,0,-2.6 parent=office desc="an office chair"
add window win at=-2.9,1,0 yaw=90 parent=office desc="a tall window with half-closed blinds"
add mannequin man at=-1.2,0,0 yaw=90 desc="a man in his 50s in shirtsleeves holding a phone to his ear" pose=talk
macro walk who=man path=1.2,0.4|0.2,-0.6 t0=1 t1=7 end=talk
cam cam1 lens=28
macro push cam=cam1 target=man from=full to=closeup angle=20 t0=0 t1=10 e=inout
ref 1 man "the man's face and clothes"
`,
  },
  {
    name: 'Street meeting',
    blurb: 'Two people meet mid-street. A wide establishing shot, then a cut to a half orbit.',
    script: `
name "Street meeting"
duration 9
look "empty city street at dusk, wet asphalt, sodium street lights, cinematic"
audio "distant traffic, footsteps on wet ground, no music"
macro street id=st length=50 width=9 seed=4
add mannequin a at=-3,0,-8 desc="a young woman in a red raincoat" yaw=20
add mannequin b at=3,0,8 desc="an older man in a dark overcoat" yaw=200
macro walk who=a path=-0.5,-0.7 t0=0 t1=4.5 end=talk
macro walk who=b path=0.5,0.7 t0=0.3 t1=4.5 end=talk
key a look t=4.6 b
key b look t=4.6 a
cam wide lens=24
macro frame cam=wide target=0,1.2,0 size=wide angle=0 height=high
set wide at=0,5,16
cam close lens=40
macro orbit cam=close target=a size=cowboy from=60 to=200 t0=4.5 t1=9
cut t=0 wide ; t=4.5 close
del cam1
ref 1 a "the woman"
ref 2 b "the man"
ref 3 location "the street"
`,
  },
  {
    name: 'Arrival',
    blurb: 'A car pulls up under a street lamp while the camera cranes down to meet the driver.',
    script: `
name "Arrival"
duration 8
look "rainy night, a single street lamp, neo-noir, high contrast"
audio "rain, an engine idling then switching off, a car door"
add plane lot size=30,0.01,30 desc="an empty parking lot"
add lamp lamp1 at=2.5,0,0 yaw=-90
add car car1 at=-14,0,0 yaw=90 desc="a dark 1980s coupe"
key car1 pos t=0 -14,0,0 ; t=5 0,0,0 e=out
add mannequin driver at=0.6,0,1.5 desc="a woman in a leather jacket" pose=stand look=cam
cam cam1 lens=32
macro crane cam=cam1 target=car1 from=6 to=1.4 dist=8 angle=30 t0=0 t1=8
ref 1 car1 "the car"
ref 2 driver "the woman"
`,
  },
];
