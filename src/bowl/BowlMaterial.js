/**
 * BowlMaterial.js (WP9)
 * One small program for the whole bowl: uKind 0 = glazed ceramic, 1 = the
 * marbled water, 2 = a falling drop (three materials, one compile). Lit by
 * the salon's shared nail-lighting uniforms (key direction, ring light, sky
 * and ground) with no texture lookups but the dye; output in display space
 * (no tone mapping) so the polish stays candy-bright.
 *
 * Water: premultiplied sRGB dye over tinted water; a relief normal from two
 * extra dye taps (uRelief = dye res; 0 on low: none); a ripple ring; Fresnel
 * sky; a thin ring light reflected in the water; a caustic at the rim.
 * uSpread (centre, area still to come) shows a drop's spread at display time,
 * so each drop costs one warp pass (one resample: the rings stay crisp).
 *
 * Warp: the exact ink-drop map of mathematical marbling. A drop of area A at
 * C moves every point at radius r out to sqrt(r^2 + A), so successive drops
 * nest as clean concentric rings. A clear drop (colour 0) is the hole a
 * dunk leaves.
 */
import * as THREE from 'three';

// The water is a lathe disc too: its uv is planar, from the local position (radius 0.315).
const VERT = `uniform int uKind;varying vec3 vP;varying vec3 vN;varying vec2 vUv;
void main(){vec4 w=modelMatrix*vec4(position,1.);vP=w.xyz;vN=mat3(modelMatrix)*normal;vUv=uKind==1?vec2(position.x,-position.z)/.63+.5:uv;gl_Position=projectionMatrix*viewMatrix*w;}`;

const FRAG = `precision highp float;
uniform int uKind;uniform sampler2D uDye;uniform vec3 uCol;uniform vec4 uRip;uniform vec3 uSpread;uniform float uRelief;
uniform vec3 uLightDir;uniform vec3 uSkyColor;uniform vec3 uGroundColor;
varying vec3 vP;varying vec3 vN;varying vec2 vUv;
float ring(vec3 R,float b){float a=sqrt(max(2.-2.*dot(R,uLightDir),0.));return smoothstep(.19-b,.19+b,a)*(1.-smoothstep(.23-b,.23+b,a));}
void main(){vec3 V=normalize(cameraPosition-vP),N=normalize(vN),c=uCol;float b=.06,r=length(vUv-.5)*2.;
if(uKind==1){vec2 p=vUv-uSpread.xy;float p2=max(dot(p,p),1e-9);p=uSpread.xy+p*sqrt((p2+uSpread.z)/p2);
vec4 d=texture2D(uDye,p);vec2 g=vec2(0.);
if(uRelief>0.){float e=1./uRelief;g=vec2(texture2D(uDye,p+vec2(e,0.)).a-d.a,texture2D(uDye,p+vec2(0.,e)).a-d.a)*3.;}
vec2 q=vUv-uRip.xy;float l=max(length(q),1e-4),w=(l-uRip.z)*70.;g+=q/l*uRip.w*sin(w)*exp(-w*w*.08);
N=normalize(vec3(-g.x,1.,g.y));c=vec3(.78,.87,.97)*(1.-d.a)+d.rgb;b=.012;}
else if(uKind==0){float t=vUv.y;c=mix(t<.6?vec3(1.,.55,.78):vec3(1.,.94,.96),vec3(1.,.8,.42),smoothstep(.55,.57,t)*(1.-smoothstep(.68,.7,t)));}
vec3 R=reflect(-V,N);float f=.04+.96*pow(1.-max(dot(N,V),0.),5.);
c=c*(.72+.28*max(dot(N,uLightDir),0.))+mix(uGroundColor,uSkyColor,R.y*.5+.5)*2.*f;
c=mix(c,vec3(1.),ring(R,b)*.55);
if(uKind==1)c=(c+vec3(.2,.19,.18)*smoothstep(.8,.92,r)*(1.-smoothstep(.92,1.,r)))*(1.-smoothstep(.93,1.,r)*.3);
gl_FragColor=vec4(c,1.);}`;

const WARP = `precision highp float;uniform sampler2D uSrc;uniform vec2 uC;uniform float uA;uniform vec4 uCol;uniform float uTex;varying vec2 vUv;
void main(){vec2 d=vUv-uC;float r2=dot(d,d);vec4 s=texture2D(uSrc,uC+d*sqrt(max(r2-uA,0.)/max(r2,1e-9)));
gl_FragColor=mix(uCol,s,smoothstep(sqrt(uA)-uTex*1.5,sqrt(uA)+uTex*.5,sqrt(r2)));}`;

/**
 * @param {0|1|2} kind ceramic, water, drop
 * @param {object} L NailScene.nailLighting (shared uniform objects)
 */
export function makeBowlMaterial(kind, L) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    toneMapped: false,
    uniforms: {
      uKind: { value: kind },
      uDye: { value: null },
      uCol: { value: new THREE.Color() },
      uRip: { value: new THREE.Vector4() },
      uSpread: { value: new THREE.Vector3() },
      uRelief: { value: 0 },
      uLightDir: L.uLightDir,
      uSkyColor: L.uSkyColor,
      uGroundColor: L.uGroundColor,
    },
  });
}

export function makeWarpMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
    fragmentShader: WARP,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      uSrc: { value: null },
      uC: { value: new THREE.Vector2() },
      uA: { value: 0 },
      uCol: { value: new THREE.Vector4() },
      uTex: { value: 0 },
    },
  });
}
