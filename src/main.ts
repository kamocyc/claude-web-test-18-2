import * as THREE from 'three';
import { Engine } from './core/Engine';
import { CameraRig } from './core/CameraRig';
import { Time } from './core/Time';
import { Input } from './core/Input';
import { Hud } from './ui/Hud';
import { Toolbar, toolSupportLevel, type ToolId } from './ui/Toolbar';
import { Alerts } from './ui/Alerts';
import { TunnelNetwork } from './game/Tunnel';
import { TunnelView } from './game/TunnelView';
import { supportName } from './game/Support';
import { SurveySystem, SurveyView, BORING_COST_PER_M, BORING_DEPTH } from './game/Survey';
import { SectionView } from './ui/SectionView';
import { VoxelField } from './terrain/VoxelField';
import { generate } from './terrain/Generator';
import { ChunkManager } from './terrain/ChunkManager';
import { createTerrainMaterial } from './terrain/TerrainMaterial';
import { raycastTerrain, type RayHit } from './terrain/raymarch';
import { applyCapsule } from './terrain/Edit';
import { Economy } from './game/Economy';
import { Excavator } from './game/Excavator';
import { BrushCursor } from './game/BrushCursor';
import {
  WORLD_X, WORLD_Z, WATER_TABLE_Y, GEO_NAME_JA, GEO_COLOR, Geo,
} from './terrain/config';

const container = document.getElementById('app')!;
const engine = new Engine(container);
const rig = new CameraRig(engine.camera, engine.canvas);
const time = new Time();
const hud = new Hud();
const input = new Input(engine.canvas);
const toolbar = new Toolbar();
const economy = new Economy();
const excavator = new Excavator();
const tunnels = new TunnelNetwork();
const tunnelView = new TunnelView();
const alerts = new Alerts();
const survey = new SurveySystem();
const surveyView = new SurveyView();
const section = new SectionView();

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

console.info(
  `[terrain] generate ${genMs.toFixed(0)}ms, mesh ${chunks.stats.lastRemeshMs.toFixed(0)}ms, ` +
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

// --- ブラシカーソル ---
const cursor = new BrushCursor();
cursor.setRadius(excavator.radius);
engine.scene.add(cursor.object);
engine.scene.add(tunnelView.object);
engine.scene.add(surveyView.object);

// --- カメラ初期位置: 尾根と谷が両方入る俯瞰 ---
rig.lookAt(
  new THREE.Vector3(WORLD_X * 0.5, 22, WORLD_Z * 0.5),
  new THREE.Vector3(WORLD_X * 0.5 - 78, 74, WORLD_Z * 0.5 + 96),
);

// --- ツール切り替え ---
toolbar.onChange = (t: ToolId) => {
  rig.setDigMode(t !== 'look');
  if (t === 'dig' || t === 'fill') excavator.mode = t;
  excavator.end();
  tunnels.endBore();
};

// --- キー ---
window.addEventListener('keydown', (e) => {
  if (e.key === '0') time.speed = 0;
  if (e.key === '1') time.speed = 1;
  if (e.key === '2') time.speed = 2;
  if (e.key === '3') time.speed = 4;
  if (e.key === '[') {
    excavator.radius = Math.max(1.2, excavator.radius - 0.4);
    cursor.setRadius(excavator.radius);
  }
  if (e.key === ']') {
    excavator.radius = Math.min(8, excavator.radius + 0.4);
    cursor.setRadius(excavator.radius);
  }
});

// --- ループ ---
const rayOrigin = new THREE.Vector3();
const rayDir = new THREE.Vector3();
let hoverGeo: Geo = Geo.Soil;
let hoverDepth = 0;
let lastCost = 0;

function swatch(g: Geo): string {
  const c = GEO_COLOR[g];
  const hex = '#' + [c[0], c[1], c[2]]
    .map((v) => Math.round(Math.min(1, v * 1.4) * 255).toString(16).padStart(2, '0'))
    .join('');
  return `<span class="swatch" style="background:${hex}"></span>${GEO_NAME_JA[g]}`;
}

function frame(): void {
  requestAnimationFrame(frame);
  time.tick();
  rig.update();

  const tool = toolbar.current;
  let hit: RayHit | null = null;

  if (tool !== 'look' && input.inside) {
    input.rayOrigin(engine.camera, rayOrigin);
    input.rayDirection(engine.camera, rayDir);
    hit = raycastTerrain(field, rayOrigin, rayDir);
  }

  if (hit) {
    hoverGeo = field.materialAt(hit.point.x, hit.point.y, hit.point.z);
    hoverDepth = hit.point.y;
    cursor.show(hit, hoverGeo, excavator.mode);
  } else {
    cursor.hide();
  }

  const supLevel = toolSupportLevel(tool);

  // --- 掘削の開始 / 継続 / 終了 ---
  if (tool === 'dig' || tool === 'fill') {
    if (input.primaryPressed && hit) excavator.begin(hit, rayDir);
    if (!input.primaryDown && excavator.isActive) {
      excavator.end();
      tunnels.endBore();
    }

    if (excavator.isActive) {
      const dt = time.realDelta * time.speed;
      const res = excavator.update(field, chunks, dt, hit, rayDir);
      if (res && res.changed) {
        lastCost = economy.chargeExcavation(res.volumeByGeo);
        // 地形が変わった範囲の構造物を再評価キューに積む。
        // 「崩落は後から地面が変わったときだけ」がここで成立する。
        tunnels.markDirtyByAABB(
          res.min[0], res.min[1], res.min[2],
          res.max[0], res.max[1], res.max[2],
        );
        if (tool === 'dig') {
          tunnels.recordBore(field, excavator.headPosition, rayDir, excavator.radius);
        }
        // 掘れば新しい壁面が露出する = そこの地質は分かるようになる
        section.invalidate();
      }
    }
  } else {
    if (excavator.isActive) {
      excavator.end();
      tunnels.endBore();
    }
    // --- 支保の設置 ---
    if (supLevel > 0 && input.primaryDown && hit) {
      const targets = tunnels.within(hit.point, excavator.radius * 2.2, []);
      for (const seg of targets) {
        if (!tunnels.queueInstall(seg, supLevel, economy) && economy.money < 1000) {
          alerts.flash('資金が足りない');
          break;
        }
      }
    }

    // --- ボーリング調査 ---
    if (tool === 'boring' && input.primaryPressed && hit) {
      const b = survey.start(field, hit.point.x, hit.point.z, economy);
      if (!b) alerts.flash('調査を開始できない (資金不足)');
      else section.invalidate();
    }

    // --- 断面線 ---
    if (tool === 'section') {
      if (input.primaryPressed && hit) section.setStart(hit.point);
      else if (input.primaryDown && hit) section.setEnd(hit.point);
    }
  }

  chunks.update(6);

  // --- トンネルの評価・施工・劣化・崩落 ---
  tunnels.update(field, chunks, time.gameDelta);
  for (const c of tunnels.recentCollapses) {
    tunnelView.burst(c.pos, excavator.radius * 1.3);
    alerts.flash(c.daylight ? '崩落 — 地表が陥没した' : '崩落 — 坑道が埋まった');
  }
  tunnelView.sync(tunnels);
  tunnelView.update(time.realDelta);
  alerts.update(tunnels, time.realDelta);

  // --- 調査 ---
  survey.update(field, time.gameDelta);
  // sync() が dirty を落とすので、その前に拾っておく
  if (survey.dirty) section.invalidate();
  surveyView.sync(survey);
  section.update(field, survey, performance.now());

  // --- HUD ---
  const rows: string[] = [];
  rows.push(`<div class="row"><span class="k">資金</span><span class="v">¥${Math.round(economy.money).toLocaleString()}</span></div>`);
  rows.push(`<div class="row"><span class="k">残土</span><span class="v">${economy.spoil.toFixed(0)} m³</span></div>`);
  if (hit) {
    rows.push(`<div class="row"><span class="k">地質</span><span class="v">${swatch(hoverGeo)}</span></div>`);
    rows.push(
      `<div class="row"><span class="k">標高</span><span class="v">${hoverDepth.toFixed(1)} m` +
      (hoverDepth < WATER_TABLE_Y ? ' <span style="color:#6cc0e8">水位下</span>' : '') +
      '</span></div>',
    );
  }
  if (excavator.isActive) {
    rows.push(
      `<div class="row"><span class="k">掘進</span><span class="v">${excavator.headSpeed.toFixed(2)} m/s</span></div>`,
    );
    rows.push(`<div class="row"><span class="k">直近費用</span><span class="v">¥${lastCost.toFixed(0)}</span></div>`);
  }

  // カーソル下のトンネル区間の状態
  if (hit) {
    const seg = tunnels.nearest(hit.point, excavator.radius * 2.5);
    if (seg) {
      rows.push(
        `<div class="row"><span class="k">土被り</span><span class="v">${seg.cover.toFixed(1)} m</span></div>`,
      );
      const short = seg.installed < seg.required;
      rows.push(
        `<div class="row"><span class="k">支保</span><span class="v"` +
        (short ? ' style="color:#e8b45c"' : '') +
        `>${supportName(seg.installed)} / 必要 ${supportName(seg.required)}</span></div>`,
      );
      if (short) {
        rows.push(
          `<div class="row"><span class="k">健全度</span><span class="v">` +
          `${(Math.max(0, seg.integrity) * 100).toFixed(0)}%</span></div>`,
        );
      }
    }
  }

  if (tool === 'boring') {
    const drilling = survey.borings.filter((b) => !b.done).length;
    rows.push(
      `<div class="row"><span class="k">調査費</span><span class="v">` +
      `¥${(BORING_DEPTH * BORING_COST_PER_M).toLocaleString()} / 本</span></div>`,
    );
    rows.push(
      `<div class="row"><span class="k">孔数</span><span class="v">${survey.borings.length}` +
      (drilling > 0 ? ` (掘進中 ${drilling})` : '') + '</span></div>',
    );
  }

  rows.push(`<div class="row"><span class="k">ブラシ</span><span class="v">R ${excavator.radius.toFixed(1)} m</span></div>`);
  hud.update(time, chunks.stats, rows.join(''));

  engine.render();
  input.endFrame();
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
      economy: Economy;
      excavator: Excavator;
      toolbar: Toolbar;
      tunnels: TunnelNetwork;
      time: Time;
      survey: SurveySystem;
      section: SectionView;
      THREE: typeof THREE;
      ready: boolean;
      view(from: [number, number, number], at: [number, number, number]): void;
      /** テスト用: ワールド座標の折れ線に沿って一気に掘る */
      carve(path: [number, number, number][], radius: number): void;
      /** テスト用: 折れ線に沿って掘りつつトンネル区間も記録する */
      bore(path: [number, number, number][], radius: number): void;
    };
  }
}

window.__game = {
  engine, rig, field, chunks, economy, excavator, toolbar, tunnels, time,
  survey, section, THREE,
  ready: true,
  view(from, at) {
    rig.lookAt(new THREE.Vector3(...at), new THREE.Vector3(...from));
  },
  carve(path, radius) {
    // 検証用。Excavator の速度制限を通さずに直接カプセルを適用する。
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const res = applyCapsule(
        field, chunks,
        a[0], a[1], a[2], b[0], b[1], b[2],
        radius, 'dig', excavator.blend, Geo.Soil,
      );
      if (res.changed) economy.chargeExcavation(res.volumeByGeo);
    }
    chunks.update(100000);
  },
  bore(path, radius) {
    const dir = new THREE.Vector3();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const res = applyCapsule(
        field, chunks,
        a[0], a[1], a[2], b[0], b[1], b[2],
        radius, 'dig', excavator.blend, Geo.Soil,
      );
      if (!res.changed) continue;
      economy.chargeExcavation(res.volumeByGeo);
      tunnels.markDirtyByAABB(
        res.min[0], res.min[1], res.min[2],
        res.max[0], res.max[1], res.max[2],
      );
      dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
      tunnels.recordBore(field, new THREE.Vector3(b[0], b[1], b[2]), dir, radius);
    }
    tunnels.endBore();
    chunks.update(100000);
  },
};
