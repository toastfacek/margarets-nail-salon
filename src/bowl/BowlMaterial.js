/**
 * BowlMaterial.js (WP9)
 * One small program for the whole bowl: uK (kind) 0 = glazed ceramic, 1 = the
 * marbled water, 2 = a falling drop (three materials, one compile). Lit by
 * the salon's shared nail-lighting uniforms (key direction, ring light, sky
 * and ground) with no texture lookups but the dye; output in display space
 * (no tone mapping) so the polish stays candy-bright.
 *
 * Water: premultiplied sRGB dye over tinted water; a relief normal from two
 * extra dye taps (uE = dye res; 0 on low: none); a ripple ring; Fresnel
 * sky; a thin ring light reflected in the water; a caustic at the rim.
 * uP (centre, area still to come) shows a drop's spread at display time,
 * so each drop costs one warp pass (one resample: the rings stay crisp).
 *
 * Warp: the exact ink-drop map of mathematical marbling. A drop of area A at
 * C moves every point at radius r out to sqrt(r^2 + A), so successive drops
 * nest as clean concentric rings. A clear drop (colour 0) is the hole a
 * dunk leaves.
 */
import * as THREE from 'three';

// The water is a lathe disc too: its uv is planar, from the local position (radius 0.315).
const VERT = `uniform int uK;varying vec3 vP;varying vec3 vN;varying vec2 vUv;
void main(){vec4 w=modelMatrix*vec4(position,1.);vP=w.xyz;vN=mat3(modelMatrix)*normal;vUv=uK==1?vec2(position.x,-position.z)/.63+.5:uv;gl_Position=projectionMatrix*viewMatrix*w;}`;

const FRAG = `precision highp float;
uniform int uK;uniform sampler2D uD;uniform vec3 uC;uniform vec4 uR;uniform vec3 uP;uniform float uE;
uniform vec3 uL;uniform vec3 uS;uniform vec3 uG;
varying vec3 vP;varying vec3 vN;varying vec2 vUv;
float ring(vec3 R,float b){float a=sqrt(max(2.-2.*dot(R,uL),0.));return smoothstep(.19-b,.19+b,a)*(1.-smoothstep(.23-b,.23+b,a));}
void main(){vec3 V=normalize(cameraPosition-vP),N=normalize(vN),c=uC;float b=.06,r=length(vUv-.5)*2.;
if(uK==1){vec2 p=vUv-uP.xy;float p2=max(dot(p,p),1e-9);p=uP.xy+p*sqrt((p2+uP.z)/p2);
vec4 d=texture2D(uD,p);vec2 g=vec2(0.);
if(uE>0.){float e=1./uE;g=vec2(texture2D(uD,p+vec2(e,0.)).a-d.a,texture2D(uD,p+vec2(0.,e)).a-d.a)*3.;}
vec2 q=vUv-uR.xy;float l=max(length(q),1e-4),w=(l-uR.z)*70.;g+=q/l*uR.w*sin(w)*exp(-w*w*.08);
N=normalize(vec3(-g.x,1.,g.y));c=vec3(.78,.87,.97)*(1.-d.a)+d.rgb;b=.012;}
else if(uK==0){float t=vUv.y;c=mix(t<.6?vec3(1.,.55,.78):vec3(1.,.94,.96),vec3(1.,.8,.42),smoothstep(.55,.57,t)*(1.-smoothstep(.68,.7,t)));}
vec3 R=reflect(-V,N);float f=.04+.96*pow(1.-max(dot(N,V),0.),5.);
c=c*(.72+.28*max(dot(N,uL),0.))+mix(uG,uS,R.y*.5+.5)*2.*f;
c=mix(c,vec3(1.),ring(R,b)*.55);
if(uK==1)c=(c+vec3(.2,.19,.18)*smoothstep(.8,.92,r)*(1.-smoothstep(.92,1.,r)))*(1.-smoothstep(.93,1.,r)*.3);
gl_FragColor=vec4(c,1.);}`;

// uX: uv transform of the lookup (a print crops the nail's footprint);
// uH: re-crisp (sharpen the film's alpha edges, colour back to full strength).
const WARP = `precision highp float;uniform sampler2D uS;uniform vec2 uC;uniform float uA;uniform vec4 uK;uniform float uT;uniform vec4 uX;uniform float uH;varying vec2 vUv;
void main(){vec2 d=vUv*uX.xy+uX.zw-uC;float r2=dot(d,d);vec4 s=texture2D(uS,uC+d*sqrt(max(r2-uA,0.)/max(r2,1e-9)));
if(uH>0.){float a=smoothstep(.1,.45,s.a);s=vec4(s.rgb/max(s.a,.02)*a,a);}
gl_FragColor=uA>0.?mix(uK,s,smoothstep(sqrt(uA)-uT*1.5,sqrt(uA)+uT*.5,sqrt(r2))):s;}`;

/**
 * @param {0|1|2} kind ceramic, water, drop
 * @param {object} L NailScene.nailLighting (shared uniform objects)
 */
// Short uniform names (the GLSL ships as text): uK kind, uD dye, uC colour,
// uR ripple, uP spread, uE relief, uL/uS/uG the salon's key/sky/ground.
export function makeBowlMaterial(kind, L) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: false,
    uniforms: {
      uK: { value: kind },
      uD: { value: null },
      uC: { value: new THREE.Color() },
      uR: { value: new THREE.Vector4() },
      uP: { value: new THREE.Vector3() },
      uE: { value: 0 },
      uL: L.uLightDir,
      uS: L.uSkyColor,
      uG: L.uGroundColor,
    },
  });
}

// Warp uniforms: uS source, uC centre, uA area, uK drop colour (premultiplied), uT texel,
// uX lookup uv transform, uH re-crisp.
export function makeWarpMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: WARP,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uS: { value: null },
      uC: { value: new THREE.Vector2() },
      uA: { value: 0 },
      uK: { value: new THREE.Vector4() },
      uT: { value: 0 },
      uX: { value: new THREE.Vector4(1, 1, 0, 0) },
      uH: { value: 0 },
    },
  });
}
