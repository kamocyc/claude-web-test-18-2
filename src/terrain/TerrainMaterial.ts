import * as THREE from 'three';
import { CELL, GEO_COLOR, Geo, NX, WATER_TABLE_Y, WORLD_Y } from './config';

/**
 * 地形のマテリアル。
 *
 * MeshStandardMaterial を onBeforeCompile で拡張する。自前の ShaderMaterial に
 * すると three のライティング・影・フォグを全部書き直すことになるので割に合わない。
 *
 * 「ボクセルに見えない」ための担当箇所:
 *  - ワールド座標ベースのトライプラナー投影。UV 展開が無いので継ぎ目が出ず、
 *    掘った直後の面にも同じ調子で乗る。
 *  - テクスチャのスケールを格子 (0.5 m) とわざと揃わない値 (3.7 m / 0.83 m) にする。
 *    揃っているとモアレのように格子が浮き上がる。
 *  - ディテールノイズの微分から法線を微妙に揺らす (Mikkelsen のバンプ)。
 *    格子と無関係な微細構造が乗るので、残っていた面の切り替わりが見えなくなる。
 *  - 地質は頂点属性 matWeight (土/岩/軟弱の重み) で混色。境界が階段状にならない。
 *  - 草地は列ごとの被覆率マップ (Vegetation) をワールド XZ で引いて上から重ねる。
 *    頂点属性にすると再メッシュを通さないと色が変わらないので、掘った所が
 *    緑のまま残る。テクスチャなら書き換えた次のフレームでそのまま出る。
 */

const VERT_PARS = /* glsl */ `
attribute vec3 matWeight;
varying vec3 vMatW;
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERT_BODY = /* glsl */ `
vMatW = matWeight;
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vMatW;
varying vec3 vWPos;
varying vec3 vWNormal;

uniform vec3 uSoil;
uniform vec3 uRock;
uniform vec3 uWeak;
uniform float uWaterTableY;
uniform float uBump;
uniform float uMacroScale;
uniform float uDetailScale;
uniform sampler2D uVegTex;
uniform float uVegUvScale;
uniform float uVegUvOffset;
uniform float uWorldY;
uniform vec3 uGrassDry;
uniform vec3 uGrassLush;

float gDetail;
float gBumpFade;

float hash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

float vnoise2( vec2 x ) {
  vec2 i = floor( x );
  vec2 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( hash12( i ), hash12( i + vec2( 1.0, 0.0 ) ), f.x ),
    mix( hash12( i + vec2( 0.0, 1.0 ) ), hash12( i + vec2( 1.0, 1.0 ) ), f.x ),
    f.y
  );
}

float fbm2( vec2 p ) {
  float a = 0.5;
  float s = 0.0;
  for ( int i = 0; i < 4; i ++ ) {
    s += a * vnoise2( p );
    p = p * 2.03 + vec2( 17.3, 9.1 );
    a *= 0.5;
  }
  return s;
}

// トライプラナー: 3 平面をブレンドして 1 つのスカラーを得る
float triplanarNoise( vec3 p, vec3 bw, float scale ) {
  return bw.x * fbm2( p.zy * scale )
       + bw.y * fbm2( p.xz * scale )
       + bw.z * fbm2( p.xy * scale );
}
`;

// diffuseColor を作る。normal_fragment より前に走るので gDetail をここで確定させる。
const FRAG_COLOR = /* glsl */ `
vec3 an = abs( vWNormal );
vec3 bw = pow( an, vec3( 6.0 ) );
bw /= max( bw.x + bw.y + bw.z, 1e-4 );

// 1 画素が覆うワールド距離 [m]。これでディテールの効きを落とす。
// 落とさないと、遠景や斜めから見たときに細かいノイズがエイリアスして
// ピクセル 2x2 単位の階段状のゴミになる (格子に見える主因のひとつだった)。
float fw = max( length( dFdx( vWPos ) ), length( dFdy( vWPos ) ) );
float detailFade = 1.0 - smoothstep( 0.12, 0.85, fw * uDetailScale );
gBumpFade = detailFade;

float macro  = triplanarNoise( vWPos, bw, uMacroScale );
float detail = triplanarNoise( vWPos, bw, uDetailScale );
gDetail = macro * 0.72 + detail * 0.28 * detailFade;

vec3 w = vMatW / max( vMatW.x + vMatW.y + vMatW.z, 1e-4 );
vec3 base = uSoil * w.x + uRock * w.y + uWeak * w.z;

// 堆積層らしさを出す薄い縞。
// 平坦な地面に出すと等高線のような縞模様になって最悪なので、
// 垂直に近い面 (崖・切土・トンネルの切羽) にだけ出す。実際そこでしか層は見えない。
float verticality = 1.0 - abs( vWNormal.y );
float bandPhase = vWPos.y * 2.1 + fbm2( vWPos.xz * 0.17 ) * 3.0;
float band = 0.5 + 0.5 * sin( bandPhase );
float bandAmt = mix( 0.11, 0.04, w.y ) * verticality * verticality;

vec3 col = base * ( 0.74 + 0.52 * gDetail ) * ( 1.0 - bandAmt + bandAmt * 2.0 * band );

// --- 草地 ---
// R = 被覆率、G = その列の地表高さ / uWorldY。
// 上を向いた面「かつ」地表のすぐ近くにだけ乗せる。上向きだけで判定すると
// 坑道の床 (法線はほぼ真上) が緑になる。切土の壁と天端も、法線と深さの
// どちらかで必ず落ちる。
vec2 vegUv = vWPos.xz * uVegUvScale + uVegUvOffset;
vec2 vegSample = texture2D( uVegTex, vegUv ).rg;
float upFace = smoothstep( 0.45, 0.86, vWNormal.y );
float nearSurf = 1.0 - smoothstep( 0.25, 1.20, vegSample.g * uWorldY - vWPos.y );
// 被覆率をそのまま混色比にすると、木が立つ程度 (0.4) の所がまだ土色のままで、
// 「裸地に木が生えている」絵になる。薄い所を持ち上げてから混ぜる。
float vegAmt = pow( vegSample.r, 0.62 ) * upFace * nearSurf;
if ( vegAmt > 0.001 ) {
  vec3 grass = mix( uGrassDry, uGrassLush, clamp( macro * 1.35, 0.0, 1.0 ) );
  // 土の起伏をそのまま草にも通す。平坦な緑を貼ると地形が板に見える。
  col = mix( col, grass * ( 0.76 + 0.46 * gDetail ), vegAmt );
}

// 地下水位より下は暗く湿らせる。企画の「水平な一本の線」はこれだけで読める。
float wet = smoothstep( uWaterTableY + 0.4, uWaterTableY - 0.4, vWPos.y );
col = mix( col, col * vec3( 0.44, 0.52, 0.60 ), wet * 0.72 );
// 水位線そのものを少しだけ光らせる
float line = exp( -pow( ( vWPos.y - uWaterTableY ) / 0.28, 2.0 ) );
col += vec3( 0.10, 0.20, 0.26 ) * line;

diffuseColor.rgb *= col;
`;

// 法線をディテールの微分で揺らす (Mikkelsen: bump mapping unparametrized surfaces)
const FRAG_BUMP = /* glsl */ `
{
  vec3 dpdx = dFdx( vWPos );
  vec3 dpdy = dFdy( vWPos );
  float dhdx = dFdx( gDetail );
  float dhdy = dFdy( gDetail );
  vec3 r1 = cross( dpdy, normal );
  vec3 r2 = cross( normal, dpdx );
  float det = dot( dpdx, r1 );
  if ( abs( det ) > 1e-8 ) {
    vec3 grad = ( r1 * dhdx + r2 * dhdy ) / det;
    // 勾配が暴れると法線が裏返って黒い斑点になる。長さで頭を押さえる。
    float gl = length( grad );
    if ( gl > 2.0 ) grad *= 2.0 / gl;
    normal = normalize( normal - uBump * gBumpFade * grad );
  }
}
`;

export interface TerrainMaterialHandle {
  material: THREE.MeshStandardMaterial;
  uniforms: Record<string, THREE.IUniform>;
}

/** 被覆率マップが差し込まれるまでの代わり。1 テクセルの裸地。 */
function emptyVegTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(new ArrayBuffer(2)), 1, 1, THREE.RGFormat);
  t.needsUpdate = true;
  return t;
}

export function createTerrainMaterial(): TerrainMaterialHandle {
  const uniforms: Record<string, THREE.IUniform> = {
    uSoil: { value: new THREE.Color(...GEO_COLOR[Geo.Soil]) },
    uRock: { value: new THREE.Color(...GEO_COLOR[Geo.Rock]) },
    uWeak: { value: new THREE.Color(...GEO_COLOR[Geo.Weak]) },
    uWaterTableY: { value: WATER_TABLE_Y },
    uBump: { value: 0.3 },
    // 格子 (0.5 m) と揃わない周期にするのが肝
    uMacroScale: { value: 1 / 3.7 },
    uDetailScale: { value: 1 / 1.13 },
    // 被覆率マップは Vegetation が持つ。差し込まれるまでは全部ゼロ (= 裸地)。
    uVegTex: { value: emptyVegTexture() },
    // ノード (i,k) はワールド (i*CELL, k*CELL) にあるので、テクセル中心へ半歩ずらす
    uVegUvScale: { value: 1 / (CELL * NX) },
    uVegUvOffset: { value: 0.5 / NX },
    uWorldY: { value: WORLD_Y },
    uGrassDry: { value: new THREE.Color(0.34, 0.38, 0.17) },
    uGrassLush: { value: new THREE.Color(0.18, 0.34, 0.12) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${FRAG_COLOR}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_BUMP}`);
  };

  material.customProgramCacheKey = () => 'terrain-triplanar-v2';

  return { material, uniforms };
}
