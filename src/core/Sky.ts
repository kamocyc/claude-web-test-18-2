import * as THREE from 'three';

/**
 * 空。カメラに追従する内向きの球に、天頂 → 地平のグラデーションを敷く。
 *
 * 単色の背景でも俯瞰では困らなかったが、一人称は画面の半分が空になる。
 * 地平線が出ないと、どちらが遠くなのかも、自分がどれだけ高い所に居るのかも
 * 読めない。フォグの色を地平の色に合わせてあるので、遠くの尾根は空へ溶ける。
 */

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize( position );
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDir;

void main() {
  vec3 d = normalize( vDir );
  vec3 c = mix( uHorizon, uZenith, pow( clamp( d.y, 0.0, 1.0 ), 0.55 ) );
  // 地平線より下は地面の照り返し。真下まで空色だと足元が浮く。
  // 沈め切らないのが肝で、真っ黒にすると俯瞰の画面下半分が虚無になる。
  c = mix( c, uGround, smoothstep( 0.0, -0.45, d.y ) * 0.8 );
  float s = max( dot( d, uSunDir ), 0.0 );
  c += uSun * pow( s, 320.0 ) * 1.8;   // 太陽そのもの
  c += uSun * pow( s, 5.0 ) * 0.12;    // まわりの空の明るみ
  gl_FragColor = vec4( c, 1.0 );
}
`;

/** 地平の色。フォグと `scene.background` もこれに揃える。 */
export const HORIZON_COLOR = 0xbdd0e0;

export function createSky(sunDir: THREE.Vector3): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x5489c6) },
      uHorizon: { value: new THREE.Color(HORIZON_COLOR) },
      uGround: { value: new THREE.Color(0xa7a396) },
      uSun: { value: new THREE.Color(0xfff0d2) },
      uSunDir: { value: sunDir.clone().normalize() },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 16), mat);
  sky.frustumCulled = false;
  // 何よりも先に、深度を書かずに塗る。あとは全部この上に載る。
  sky.renderOrder = -1;
  sky.name = 'sky';
  return sky;
}
