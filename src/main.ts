import * as THREE from 'three';
import { Engine } from './core/Engine';
import { CameraRig } from './core/CameraRig';
import { Time } from './core/Time';
import { Hud } from './ui/Hud';
import { VoxelField } from './terrain/VoxelField';
import { generate } from './terrain/Generator';
import { ChunkManager } from './terrain/ChunkManager';
import { createTerrainMaterial } from './terrain/TerrainMaterial';
import { WORLD_X, WORLD_Z, WATER_TABLE_Y } from './terrain/config';

const container = document.getElementById('app')!;
const engine = new Engine(container);
const rig = new CameraRig(engine.camera, engine.canvas);
const time = new Time();
const hud = new Hud();

// --- 地形の生成とメッシュ化 ---
const tGen0 = performance.now();
const field = new VoxelField();
generate(field);
const genMs = performance.now() - tGen0;

// デバッグ用: ?mat=normal で法線、?mat=plain で無地。
// 「格子が見える」原因がジオメトリ側かシェーダ側かを切り分けるために使う。
const matParam = new URLSearchParams(location.search).get('mat');
const terrainMat = createTerrainMaterial();
const debugMat =
  matParam === 'normal'
    ? new THREE.MeshNormalMaterial()
    : matParam === 'plain'
      ? new THREE.MeshStandardMaterial({ color: 0xa08363, roughness: 0.95 })
      : null;
const chunks = new ChunkManager(field, debugMat ?? terrainMat.material);
chunks.buildAll();
engine.scene.add(chunks.group);

const meshMs = chunks.stats.lastRemeshMs;
console.info(
  `[terrain] generate ${genMs.toFixed(0)}ms, mesh ${meshMs.toFixed(0)}ms, ` +
  `${chunks.stats.meshedChunks} chunks, ${chunks.stats.triangles.toFixed(0)} tris, ` +
  `SharedArrayBuffer=${field.shared}`,
);

// --- 地下水位の面。トンネルの中から見上げたときの手がかりになる。 ---
const waterPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(WORLD_X, WORLD_Z),
  new THREE.MeshBasicMaterial({
    color: 0x2d6b8f,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  }),
);
waterPlane.rotation.x = -Math.PI / 2;
waterPlane.position.set(WORLD_X / 2, WATER_TABLE_Y, WORLD_Z / 2);
waterPlane.renderOrder = 2;
engine.scene.add(waterPlane);

// --- カメラ初期位置: 尾根と谷が両方入る俯瞰 ---
rig.lookAt(
  new THREE.Vector3(WORLD_X * 0.5, 22, WORLD_Z * 0.5),
  new THREE.Vector3(WORLD_X * 0.5 - 78, 74, WORLD_Z * 0.5 + 96),
);

// --- 速度キー ---
window.addEventListener('keydown', (e) => {
  if (e.key === '0') time.speed = 0;
  if (e.key === '1') time.speed = 1;
  if (e.key === '2') time.speed = 2;
  if (e.key === '3') time.speed = 4;
});

function frame(): void {
  requestAnimationFrame(frame);
  time.tick();
  rig.update();
  chunks.update(6);
  hud.update(time, chunks.stats);
  engine.render();
}
frame();

// --- デバッグ用の口。スクリーンショット検証スクリプトから叩く。 ---
declare global {
  interface Window {
    __game: {
      engine: Engine;
      rig: CameraRig;
      field: VoxelField;
      chunks: ChunkManager;
      ready: boolean;
      /** カメラを任意の位置・注視点へ即座に飛ばす */
      view(from: [number, number, number], at: [number, number, number]): void;
    };
  }
}

window.__game = {
  engine,
  rig,
  field,
  chunks,
  ready: true,
  view(from, at) {
    rig.lookAt(new THREE.Vector3(...at), new THREE.Vector3(...from));
  },
};
