import * as THREE from 'three';
import { Engine } from './core/Engine';
import { CameraRig } from './core/CameraRig';
import { Time } from './core/Time';
import { Input } from './core/Input';
import { Hud } from './ui/Hud';
import { Toolbar, toolSupportLevel, toolSlopeLevel, type ToolId } from './ui/Toolbar';
import { Alerts } from './ui/Alerts';
import { TunnelNetwork, type TunnelSegment } from './game/Tunnel';
import { TunnelView } from './game/TunnelView';
import { supportName } from './game/Support';
import { Crew } from './game/Crew';
import { SlopeWorks, slopeWorkDef, slopeWorkName } from './game/SlopeWorks';
import { SlopeWorksView } from './game/SlopeWorksView';
import { SurveySystem, SurveyView, BORING_COST_PER_M, BORING_DEPTH } from './game/Survey';
import { SectionView } from './ui/SectionView';
import { VoxelField } from './terrain/VoxelField';
import { generate } from './terrain/Generator';
import { ChunkManager } from './terrain/ChunkManager';
import { createTerrainMaterial } from './terrain/TerrainMaterial';
import { raycastTerrain, overburdenAt, type RayHit } from './terrain/raymarch';
import { applyCapsule } from './terrain/Edit';
import { HeightIndex } from './terrain/HeightIndex';
import { ReposeSystem, slopeInfoAt } from './terrain/Repose';
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
const strata = generate(field);
const genMs = performance.now() - tGen0;

// --- 安息角: 世界を最初から釣り合った状態にしておく ---
// 生成直後の地形には、原地盤が自立できる角度より急な所がまだ残っている。
// 先に均しておかないと「掘っていない所が突然崩れる」ように見える。
// メッシュ化の前に済ませるので、この整定にメッシュの作り直しは掛からない。
const tSettle0 = performance.now();
const heightIndex = new HeightIndex();
heightIndex.measureAll(field, strata.height);
const repose = new ReposeSystem(heightIndex);
// 施工班は 1 班。支保と法面保護工が同じ列に並んで奪い合う。
const crew = new Crew();
const slopeWorks = new SlopeWorks(heightIndex, crew);
const slopeView = new SlopeWorksView();
repose.seedAll();
repose.settleNow(field, null);
tunnels.useCrew(crew);
const settleMs = performance.now() - tSettle0;
const settleVol = repose.movedThisSlide;

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
  `[terrain] generate ${genMs.toFixed(0)}ms, ` +
  `settle ${settleMs.toFixed(0)}ms (${settleVol.toFixed(0)} m3), ` +
  `mesh ${chunks.stats.lastRemeshMs.toFixed(0)}ms, ` +
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
engine.scene.add(slopeView.object);

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
let lastPreviewMs = 0;
let previewHtml = '';
let aimSeg: TunnelSegment | null = null;
let hoverGeo: Geo = Geo.Soil;
let hoverDepth = 0;
let lastCost = 0;
/** 今の地滑りで動いた土量 [m^3]。崩れ切ったところで 1 回だけ知らせる。 */
let slideVolume = 0;

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

  const supLevel = toolSupportLevel(tool);
  const slopeLevel = toolSlopeLevel(tool);

  if (supLevel === 0 && hit) {
    hoverGeo = field.materialAt(hit.point.x, hit.point.y, hit.point.z);
    hoverDepth = hit.point.y;
    cursor.show(hit, hoverGeo, excavator.mode);
  } else if (supLevel === 0) {
    cursor.hide();
  }

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
        // 掘った所は原地盤がゆるむ。急ければこのフレームのうちに崩れる。
        repose.seedFromEdit(field, res);
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
    // 狙いは「地表のヒット点の近く」ではなく「カーソルのレイが貫く区間」で採る。
    // ヒット点で採ると、山の外から狙ったときヒット点が地表にあり、
    // 坑道までは土被りぶん離れているので何も選べない。
    if (supLevel > 0) {
      input.rayOrigin(engine.camera, rayOrigin);
      input.rayDirection(engine.camera, rayDir);
      aimSeg = input.inside
        ? tunnels.nearestToRay(rayOrigin, rayDir, excavator.radius * 1.6, supLevel)
        : null;

      if (aimSeg && input.primaryDown) {
        // 狙った区間を中心に、その前後をまとめて予約する (なぞって塗れるように)
        const targets = tunnels.within(aimSeg.pos, excavator.radius * 2.2, []);
        for (const seg of targets) {
          if (!tunnels.queueInstall(seg, supLevel, economy) && economy.money < 1000) {
            alerts.flash('資金が足りない');
            break;
          }
        }
      }
    } else {
      aimSeg = null;
    }

    if (aimSeg) cursor.showAtSegment(aimSeg.pos, aimSeg.dir, aimSeg.radius);
    else if (supLevel > 0) cursor.hide();

    // --- 法面保護工を塗る ---
    // 崩れてから直すのではなく、掘る前に手当てしておくための道具。
    // 費用は押した瞬間の前払いで、効くのは施工班の順番が来てから。
    if (slopeLevel > 0 && input.primaryDown && hit) {
      if (!slopeWorks.paint(hit.point.x, hit.point.z, excavator.radius, slopeLevel, economy)) {
        const pv = slopeWorks.preview(hit.point.x, hit.point.z, excavator.radius, slopeLevel);
        if (pv.cost > economy.money) alerts.flash('資金が足りない');
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

  // --- 安息角: 急な法面を崩す ---
  // chunks.update より前に置くので、掘る → 崩れる → 再メッシュ が同じフレームで揃う。
  // tunnels.update より前に置くのも大事で、崩れて土被りが減ったことを
  // そのフレームの支保の判定に間に合わせられる (後ろに置くと必ず 1 フレーム遅れる)。
  // ゲーム内時間ではなく実時間の予算で回すので、時間を止めていても崩れる。
  const slide = repose.update(field, chunks, 4);
  if (slide) {
    tunnels.markDirtyByAABB(
      slide.min[0], slide.min[1], slide.min[2],
      slide.max[0], slide.max[1], slide.max[2],
    );
    section.invalidate();
    slideVolume += repose.movedThisSlide;
  }
  // 崩れ切ったところで 1 回だけ知らせる。毎フレーム出すと読めない。
  if (!repose.active && slideVolume > 0) {
    if (slideVolume > 20) alerts.flash(`法面が崩れた — 土砂 ${slideVolume.toFixed(0)} m³ が動いた`);
    slideVolume = 0;
  }

  chunks.update(6);

  // --- 施工班 (支保と法面保護工で 1 班) ---
  // tunnels.update より前に回す。支保が入った結果を同じフレームの
  // 劣化判定へ渡したい。
  if (crew.update(time.gameDelta)) slopeWorks.dirtyVisuals = true;

  // --- トンネルの評価・施工・劣化・崩落 ---
  tunnels.update(field, chunks, time.gameDelta);

  // 支保不足は、健全度が落ちてからではなく「不足が確定した瞬間」に知らせる。
  // 掘っている最中にその場で出るので、掘り進むか支保を入れるかを即座に選べる。
  if (tunnels.newlyAtRisk.length > 0) {
    const w = tunnels.newlyAtRisk.reduce((a, b) =>
      TunnelNetwork.hoursToFailure(b) < TunnelNetwork.hoursToFailure(a) ? b : a,
    );
    alerts.flash(
      `⚠ ${GEO_NAME_JA[w.worstGeo]}${w.belowWater ? '・水位下' : ''} — ` +
      `${supportName(w.required)} が必要 / あと ${Alerts.fmtHours(TunnelNetwork.hoursToFailure(w))}`,
    );
  }

  for (const c of tunnels.recentCollapses) {
    tunnelView.burst(c.pos, excavator.radius * 1.3);
    alerts.flash(c.daylight ? '崩落 — 地表が陥没した' : '崩落 — 坑道が埋まった');
    // 陥没孔は垂直に開く。縁が安息角まで寝て漏斗状になる。
    if (c.daylight) repose.seedAround(c.pos.x, c.pos.z, excavator.radius * 2);
  }
  tunnelView.sync(tunnels);
  tunnelView.update(time.realDelta);
  alerts.update(tunnels, time.realDelta);

  // --- 調査 ---
  // 保護工の板は地表に載せているので、崩落で地形が動いたら作り直す
  if (slopeWorks.dirtyVisuals || slide) {
    slopeWorks.dirtyVisuals = false;
    slopeView.rebuild(heightIndex, slopeWorks);
  }

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
  // 地面が勝手に動く理由が見えないと、ただ理不尽に感じられる。
  // 掘る前に「今どれだけ急で、どこまでなら立つのか」を出しておく。
  if (hit && (tool === 'dig' || tool === 'fill')) {
    const si = slopeInfoAt(heightIndex, hit.point.x, hit.point.z);
    if (si) {
      const limit = si.loose ? si.reposeDeg : si.insituDeg;
      const over = si.slopeDeg > limit + 1;
      rows.push(
        `<div class="row"><span class="k">法面</span><span class="v"` +
        (over ? ' style="color:#e8b45c"' : '') +
        `>${si.slopeDeg.toFixed(0)}° / 限界 ${limit.toFixed(0)}°` +
        (over ? ' 崩れる' : '') +
        `</span></div>`,
      );
      // 原地盤なら「掘るとここまで寝る」を先に見せる。用地の判断に直結する。
      const guard = slopeWorks.plannedAt(hit.point.x, hit.point.z);
      if (guard > 0) {
        rows.push(
          `<div class="row"><span class="k">保護工</span>` +
          `<span class="v">${slopeWorkName(guard)} ${slopeWorkDef(guard)!.deg}°` +
          (slopeWorks.levelAt(hit.point.x, hit.point.z) < guard ? ' <span style="color:#93a0b4">施工待ち</span>' : '') +
          `</span></div>`,
        );
      } else if (!si.loose) {
        rows.push(
          `<div class="row"><span class="k">掘ると</span>` +
          `<span class="v" style="color:#93a0b4">安息角 ${si.reposeDeg.toFixed(0)}° まで寝る</span></div>`,
        );
      }
    }
  }

  // 保護工ツール: 押す前に「いくらで、どれだけ待つか」を出す。
  // 前払いなので、押してから知るのでは遅い。
  if (slopeLevel > 0 && hit) {
    const def = slopeWorkDef(slopeLevel)!;
    const pv = slopeWorks.preview(hit.point.x, hit.point.z, excavator.radius, slopeLevel);
    rows.push(
      `<div class="row"><span class="k">工法</span>` +
      `<span class="v">${def.name} — ${def.deg}° まで立つ</span></div>`,
    );
    rows.push(
      `<div class="row"><span class="k">この一塗り</span>` +
      `<span class="v"${pv.cost > economy.money ? ' style="color:#e8705a"' : ''}>` +
      `${pv.area.toFixed(0)} m² / ¥${Math.round(pv.cost).toLocaleString()}</span></div>`,
    );
    if (crew.length > 0) {
      rows.push(
        `<div class="row"><span class="k">施工待ち</span>` +
        `<span class="v">${crew.length} 件 / あと ${Alerts.fmtHours(crew.totalHours)}</span></div>`,
      );
    }
  }

  if (excavator.isActive) {
    rows.push(
      `<div class="row"><span class="k">掘進</span><span class="v">${excavator.headSpeed.toFixed(2)} m/s</span></div>`,
    );
    rows.push(`<div class="row"><span class="k">直近費用</span><span class="v">¥${lastCost.toFixed(0)}</span></div>`);
  }

  // 掘る前の下見。「掘っているのに何も起きない」の正体は、
  // たいてい斜面を下りながら地表すれすれを削っているだけ (土被りがつかない)。
  // 場を歩くので毎フレームは重い。8 Hz に間引いて結果を使い回す。
  if (hit && tool === 'dig') {
    const now = performance.now();
    if (now - lastPreviewMs > 125) {
      lastPreviewMs = now;
      const pv = tunnels.previewBore(field, hit.point, rayDir, excavator.radius);
      previewHtml = pv.found
        ? `<div class="row"><span class="k">この向き</span>` +
          `<span class="v" style="color:#8fd0a0">` +
          (pv.dist <= excavator.radius * 1.5
            ? 'トンネル'
            : `あと ${pv.dist.toFixed(0)} m でトンネル`) +
          `</span></div>` +
          `<div class="row"><span class="k">土被り</span>` +
          `<span class="v">${pv.seg.cover.toFixed(1)} m</span></div>` +
          `<div class="row"><span class="k">必要支保</span><span class="v"` +
          (pv.seg.required > 0 ? ' style="color:#e8b45c"' : '') +
          `>${supportName(pv.seg.required)}</span></div>`
        : `<div class="row"><span class="k">この向き</span>` +
          `<span class="v" style="color:#93a0b4">切土 — 潜れない</span></div>` +
          `<div class="row"><span class="k"></span>` +
          `<span class="v" style="color:#93a0b4;font-size:11px">斜面を見上げる向きに差す</span></div>`;
    }
    rows.push(previewHtml);
  } else {
    previewHtml = '';
  }

  // カーソル下のトンネル区間の状態。
  // 支保ツールのときは「実際に設置される区間」を出す (狙いと表示を一致させる)。
  {
    const seg = supLevel > 0
      ? aimSeg
      : hit ? tunnels.nearest(hit.point, excavator.radius * 2.5) : null;
    if (supLevel > 0 && !seg) {
      rows.push(
        '<div class="row"><span class="k">狙い</span>' +
        '<span class="v" style="color:#93a0b4">区間なし — 坑道か警告柱を狙う</span></div>',
      );
    }
    if (seg) {
      if (supLevel > 0) {
        rows.push(
          `<div class="row"><span class="k">狙い</span>` +
          `<span class="v" style="color:#9fe8ff">この区間 ±${(excavator.radius * 2.2).toFixed(0)} m</span></div>`,
        );
      }
      const eta = tunnels.installEta(seg);
      if (eta !== null) {
        // 施工班は 1 班なので順番待ちがある。押した瞬間に金だけ減って
        // 見た目が変わらないので、いつ入るのかを必ず出す。
        rows.push(
          `<div class="row"><span class="k">施工</span>` +
          `<span class="v" style="color:#9fe8ff">${supportName(seg.installTarget)} ` +
          `あと ${Alerts.fmtHours(eta)}</span></div>`,
        );
      }
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
      repose: ReposeSystem;
      heightIndex: HeightIndex;
      slopeWorks: SlopeWorks;
      crew: Crew;
      slopeInfoAt: typeof slopeInfoAt;
      THREE: typeof THREE;
      TunnelNetwork: typeof TunnelNetwork;
      raycastTerrain: typeof raycastTerrain;
      overburdenAt: typeof overburdenAt;
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
  survey, section, THREE, TunnelNetwork, raycastTerrain, overburdenAt,
  repose, heightIndex, slopeInfoAt, slopeWorks, crew,
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
      if (res.changed) {
        economy.chargeExcavation(res.volumeByGeo);
        repose.seedFromEdit(field, res);
      }
    }
    repose.settleNow(field, chunks);
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
      repose.seedFromEdit(field, res);
    }
    tunnels.endBore();
    repose.settleNow(field, chunks);
    chunks.update(100000);
  },
};
