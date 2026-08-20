import * as THREE from 'three';
import { Engine, type ViewMode } from './core/Engine';
import { CameraRig } from './core/CameraRig';
import { FirstPerson } from './core/FirstPerson';
import { Time } from './core/Time';
import { Input } from './core/Input';
import { Hud } from './ui/Hud';
import { Toolbar, toolSupportLevel, toolSlopeLevel, type ToolId } from './ui/Toolbar';
import { Alerts } from './ui/Alerts';
import { ViewUi } from './ui/ViewUi';
import { TunnelNetwork, type TunnelSegment } from './game/Tunnel';
import { TunnelView } from './game/TunnelView';
import { supportName } from './game/Support';
import { Crew } from './game/Crew';
import { SlopeWorks, slopeWorkDef, slopeWorkName } from './game/SlopeWorks';
import { SlopeWorksView } from './game/SlopeWorksView';
import { SurveySystem, SurveyView, BORING_COST_PER_M, BORING_DEPTH } from './game/Survey';
import {
  buildAlignment, lengthByKind, ROAD_STANDARDS, RoadKind, ROAD_KIND_NAME,
  type Alignment, type RoadStandard, type Vec2,
} from './game/Alignment';
import { planRoad, RoadNetwork, groundHeightAt, terrainProbe, type RoadPlan } from './game/Roadworks';
import { BridgeNetwork } from './game/Bridge';
import { RoadView, roadKindCss, describeBridge } from './game/RoadView';
import { SectionView } from './ui/SectionView';
import { VoxelField } from './terrain/VoxelField';
import { generate } from './terrain/Generator';
import { ChunkManager } from './terrain/ChunkManager';
import { createTerrainMaterial } from './terrain/TerrainMaterial';
import { raycastTerrain, overburdenAt, type RayHit } from './terrain/raymarch';
import { applyCapsule } from './terrain/Edit';
import { HeightIndex, colIdx, isRimColumn } from './terrain/HeightIndex';
import { ReposeSystem, slopeInfoAt } from './terrain/Repose';
import { Economy } from './game/Economy';
import { Excavator } from './game/Excavator';
import { BrushCursor } from './game/BrushCursor';
import { REACH } from './game/Player';
import { Vegetation } from './terrain/Vegetation';
import { VegetationView } from './game/VegetationView';
import {
  CELL, WORLD_X, WORLD_Z, WATER_TABLE_Y, GEO_NAME_JA, GEO_COLOR, Geo,
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
const viewUi = new ViewUi();
const fp = new FirstPerson(engine.camera, engine.canvas);

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

// --- 植生。整定が済んで地表が確定してから種を撒く ---
// 先に撒くと、生成直後に残っていた急斜面ぶんだけ緑が余分に付き、
// 最初の整定でそれが一斉に剥がれる (何もしていないのに山が禿げる)。
const vegetation = new Vegetation();
vegetation.seedAll(heightIndex);

// --- 道路と橋。施工班は支保・保護工と同じ 1 班を共有する ---
const bridges = new BridgeNetwork();
bridges.useCrew(crew);
const roads = new RoadNetwork(crew);
const roadView = new RoadView();
const settleMs = performance.now() - tSettle0;
const settleVol = repose.movedThisSlide;

// デバッグ用: ?mat=normal で法線、?mat=plain で無地。
// 「格子が見える」原因がジオメトリ側かシェーダ側かを切り分けるために使う。
const params = new URLSearchParams(location.search);
const matParam = params.get('mat');
/** ?veg=0 で植生を切る。「緑が地質を隠していないか」を見比べるため。 */
const vegOn = params.get('veg') !== '0';
/** ?shadows=0 で木の影を切る。フレーム時間の実測用。 */
const shadowsOn = params.get('shadows') !== '0';
const terrainMat = createTerrainMaterial();
const debugMat =
  matParam === 'normal'
    ? new THREE.MeshNormalMaterial()
    : matParam === 'plain'
      ? new THREE.MeshStandardMaterial({ color: 0xa08363, roughness: 0.95 })
      : null;
// 草地の色は地形シェーダが被覆率マップから引く。頂点属性ではないので、
// 掘って被覆率が落ちた列は再メッシュを待たずにその場で土の色へ戻る。
if (vegOn) terrainMat.uniforms.uVegTex.value = vegetation.maskTexture;
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

// --- 木と草 ---
const vegView = new VegetationView();
if (vegOn) engine.scene.add(vegView.object);
// 影を落とすのは木だけ。範囲は世界ちょうどを覆う直交カメラ 1 枚で足りる。
if (shadowsOn) engine.configureSun(new THREE.Vector3(WORLD_X / 2, 20, WORLD_Z / 2), 100);

// --- ブラシカーソル ---
const cursor = new BrushCursor();
cursor.setRadius(excavator.radius);
engine.scene.add(cursor.object);
engine.scene.add(tunnelView.object);
engine.scene.add(surveyView.object);
engine.scene.add(slopeView.object);
engine.scene.add(roadView.object);

// --- カメラ初期位置: 尾根と谷が両方入る俯瞰 ---
rig.lookAt(
  new THREE.Vector3(WORLD_X * 0.5, 22, WORLD_Z * 0.5),
  new THREE.Vector3(WORLD_X * 0.5 - 78, 74, WORLD_Z * 0.5 + 96),
);

// --- 視点モード ---
// 俯瞰と一人称は**同じカメラを排他で**使う。両方が毎フレーム書きに来ると、
// OrbitControls の減衰の残りが一人称の視点を引っぱる。
//
// 一人称で変わるのは 3 つだけで、それ以外の道具の処理は俯瞰とまったく同じ経路を通る。
//   1. 狙いが画面中央に固定される (ポインタロック)
//   2. 届く距離が 4.5 m になる (`REACH`)
//   3. ブラシ半径の上限が 1.8 m になる (腕の届く仕事の大きさ)
let viewMode: ViewMode = 'orbit';
const FP_BRUSH_MAX = 1.8;
const ORBIT_BRUSH_MAX = 8;

const ORBIT_HELP = '<b>左ドラッグ</b> 回転 / <b>右ドラッグ</b> 平行移動 / <b>ホイール</b> ズーム';
const FP_HELP =
  '<b>WASD</b> 移動 / <b>Space</b> 跳ぶ / <b>Shift</b> 走る / ' +
  '<b>ホイール</b> 道具の持ち替え / 届くのは正面 4.5 m まで';

function brushMax(): number {
  return viewMode === 'fp' ? FP_BRUSH_MAX : ORBIT_BRUSH_MAX;
}

function setBrushRadius(r: number): void {
  excavator.radius = Math.max(1.2, Math.min(brushMax(), r));
  cursor.setRadius(excavator.radius);
}

function setViewMode(mode: ViewMode): void {
  if (mode === viewMode) return;
  viewMode = mode;
  excavator.end();
  tunnels.endBore();
  engine.setViewMode(mode);
  input.centered = mode === 'fp';
  toolbar.hotkeys = mode !== 'fp';
  toolbar.modeHelp = mode === 'fp' ? FP_HELP : ORBIT_HELP;
  toolbar.refreshHelp();

  if (mode === 'fp') {
    rig.setEnabled(false);
    // 今の注視点の真下に立たせる。俯瞰で見ていた場所へそのまま降りられる。
    fp.enter(field, rig.controls.target.x, rig.controls.target.z);
    setBrushRadius(excavator.radius);
  } else {
    fp.exit();
    rig.setEnabled(true);
    // 立っていた所を見下ろす位置に戻す。俯瞰へ戻った瞬間に
    // まったく別の場所を見ていると、さっきまで居た所を探す羽目になる。
    const p = fp.player.pos;
    rig.lookAt(
      new THREE.Vector3(p.x, p.y + 2, p.z),
      new THREE.Vector3(p.x - 30, p.y + 38, p.z + 40),
    );
  }
  viewUi.setMode(mode);
  viewUi.setLocked(fp.locked);
}

viewUi.onToggle = () => setViewMode(viewMode === 'fp' ? 'orbit' : 'fp');
// 一人称では WASD が塞がるので、道具の持ち替えはホイールで送る。
fp.onWheel = (d) => toolbar.cycle(d);
// Esc やタブ切替でロックが外れた瞬間の mouseup は拾えない。
// 落としておかないと、押しっぱなし扱いのまま掘り続ける。
fp.onUnlock = () => input.clear();
// ポインタロックはクリックでしか取れない。掴めていない間は道具も動かないので、
// このクリックでいきなり地面を掘ることにはならない。
engine.canvas.addEventListener('pointerdown', () => {
  if (viewMode === 'fp') fp.requestLock();
});
toolbar.modeHelp = ORBIT_HELP;
toolbar.refreshHelp();

// --- 路線ツールの状態 ---
// 制御点は「どこを通したいか」であって「どこを通るか」ではない。
// 規格を満たす中心線は毎回そこから解き直すので、制御点はただの入力として持つ。
const control: Vec2[] = [];
let roadStd: RoadStandard = ROAD_STANDARDS[0];
let alignment: Alignment | null = null;
let roadPlan: RoadPlan | null = null;
/**
 * 制御点か規格が変わったら解き直す。毎フレームやるには重い
 * (実測 49-91 ms。ほとんどは回廊の展開で、線形そのものは 10 ms 前後)。
 */
let alignDirty = false;

const groundAt = (x: number, z: number): number => groundHeightAt(heightIndex, x, z);
/**
 * 線形の分類に渡す地形の読み口。
 * トンネルかどうかは掘る側とまったく同じ述語で答える (`Tunnel.isTunnelCover`)。
 */
const probe = terrainProbe(field, heightIndex);

/**
 * **既知の情報だけ**で地質を読むサンプラ。橋脚の支持力の見積りに使う。
 *
 * 見えている地表は定義上すべて露出面なので、地表近くは真の値でよい (§5)。
 * それより深い所は、ボーリングで裏付けが取れていなければ
 * 「地表の地質がそのまま下へ続く」という素朴な仮定で答える。
 * だから未調査の谷では「岩だと思って架けたら軟弱層だった」が起きる。
 * 着工時は真の場で評価し直すので、そこで深礎が伸びるか、橋脚が立たない。
 */
function knownGeoAt(x: number, y: number, z: number): Geo {
  const gh = groundAt(x, z);
  if (y > gh - 2) return field.materialAt(x, y, z);
  if (survey.confidenceAt(x, y, z) >= 0.35) return field.materialAt(x, y, z);
  const i = Math.round(x / CELL);
  const k = Math.round(z / CELL);
  if (isRimColumn(i, k)) return Geo.Soil;
  return heightIndex.surfaceMat(colIdx(i, k));
}

const trueGeoAt = (x: number, y: number, z: number): Geo => field.materialAt(x, y, z);

function replanRoad(): void {
  alignment = control.length >= 2 ? buildAlignment(control, probe, roadStd) : null;
  roadPlan = alignment
    ? planRoad(field, heightIndex, alignment, economy, knownGeoAt)
    : null;
  roadView.showPreview(alignment, roadPlan, control);
  alignDirty = false;
}

function startRoad(): void {
  if (!roadPlan || !roadPlan.ok || !alignment) {
    alerts.flash(roadPlan?.problems[0] ?? '制御点を 2 点以上置く');
    return;
  }
  const built = roads.build(
    field, chunks, heightIndex, repose, tunnels, bridges, economy, roadPlan,
  );
  if (!built) {
    alerts.flash('着工できない');
    return;
  }
  alerts.flash(
    `着工 — ${alignment.length.toFixed(0)} m / ` +
    `切土 ${roadPlan.cutVolume.toFixed(0)} m³ / 盛土 ${roadPlan.fillVolume.toFixed(0)} m³`,
  );
  roadView.rebuildPaved(roads.roads);
  // 路面の列は緑を止める。切土・盛土なら地表が動くので勝手に剥がれるが、
  // 平坦地をそのまま通した区間は高さが動かないので、ここで印を付けないと
  // 舗装の下から草が生える。
  for (const st of alignment.stations) {
    if (st.kind === RoadKind.Tunnel || st.kind === RoadKind.Bridge) continue;
    vegetation.paveDisc(st.x, st.z, alignment.std.width * 0.5);
  }
  section.invalidate();
  control.length = 0;
  alignment = null;
  roadPlan = null;
  roadView.showPreview(null, null, control);
}

// --- ツール切り替え ---
toolbar.onChange = (t: ToolId) => {
  rig.setDigMode(t !== 'look');
  if (t === 'dig' || t === 'fill') excavator.mode = t;
  excavator.end();
  tunnels.endBore();
  // 路線ツールから離れても検討中の線形は捨てない (掘ってから戻ってこられる)
  roadView.showPreview(t === 'align' ? alignment : null, roadPlan, t === 'align' ? control : []);
};

// --- キー ---
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    // ブラウザのフォーカス送りを止める。押した瞬間に視点が入れ替わる。
    e.preventDefault();
    setViewMode(viewMode === 'fp' ? 'orbit' : 'fp');
    return;
  }
  if (e.key === '0') time.speed = 0;
  if (e.key === '1') time.speed = 1;
  if (e.key === '2') time.speed = 2;
  if (e.key === '3') time.speed = 4;
  if (e.key === '[') setBrushRadius(excavator.radius - 0.4);
  if (e.key === ']') setBrushRadius(excavator.radius + 0.4);

  // --- 路線ツール ---
  if (toolbar.current !== 'align') return;
  if (e.key === 'Enter') {
    startRoad();
  } else if (e.key === 'Backspace') {
    e.preventDefault();
    control.pop();
    alignDirty = true;
  } else if (e.key === 'Escape') {
    control.length = 0;
    alignDirty = true;
  } else if (e.key === 'v' || e.key === 'V') {
    // 規格を替えると、同じ制御点でも通る線が変わる。
    // 曲がれないほうが尾根を切り、谷を跨ぐことになる。
    const i = ROAD_STANDARDS.indexOf(roadStd);
    roadStd = ROAD_STANDARDS[(i + 1) % ROAD_STANDARDS.length];
    alignDirty = true;
    alerts.flash(
      `規格 ${roadStd.name} — R ${roadStd.minRadius} m / ` +
      `勾配 ${(roadStd.maxGrade * 100).toFixed(0)} % / 幅 ${roadStd.width} m`,
    );
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

  // --- 視点 ---
  // 歩くのは実時間で回す。整定 (repose) と同じ理屈で、時間を止めていても
  // 崩れた所を見に行けないと判断の材料にならない。
  const fpv = viewMode === 'fp';
  if (fpv) fp.update(field, time.realDelta);
  else rig.update();
  viewUi.setLocked(fp.locked);

  // 坑内の灯り。地表が頭より上にある = 山の中に居る、で点ける。
  // 「入ったら点く」を条件で決めておくと、坑口を抜ける瞬間に自然に切り替わる。
  {
    const p = fp.player.pos;
    const underground = fpv && groundAt(p.x, p.z) > p.y + 2.4;
    const want = underground ? 11 : 0;
    engine.headlamp.intensity += (want - engine.headlamp.intensity) * Math.min(1, time.realDelta * 5);
    if (engine.headlamp.intensity > 0.01) engine.headlamp.position.copy(engine.camera.position);
  }

  const tool = toolbar.current;
  let hit: RayHit | null = null;
  // 一人称は視点を掴んでいる間だけ道具が動く。掴むためのクリックで
  // いきなり地面を掘らないための蓋でもある。
  const aiming = fpv ? fp.locked : input.inside;
  const pressed = aiming && input.primaryPressed;
  const held = aiming && input.primaryDown;

  if (tool !== 'look' && aiming) {
    input.rayOrigin(engine.camera, rayOrigin);
    input.rayDirection(engine.camera, rayDir);
    // 一人称で届くのは正面 REACH まで。ここ 1 行が「すぐ前にあるものしか
    // 扱えない」の全部で、道具の側には一切手を入れていない。
    hit = raycastTerrain(field, rayOrigin, rayDir, fpv ? REACH : 400);
    // 目が壁にめり込むと距離 0 のヒットが返る (raycastTerrain の起点が固体の分岐)。
    // そのまま渡すと自分の足元を掘る。
    if (hit && hit.distance < 0.15) hit = null;
  }
  if (fpv) viewUi.setAim(hit !== null);

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
    if (pressed && hit) excavator.begin(hit, rayDir);
    if (!held && excavator.isActive) {
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
        // 橋も同じ信号で拾う — 橋脚の足元を掘れば支持力が落ちる。
        tunnels.markDirtyByAABB(
          res.min[0], res.min[1], res.min[2],
          res.max[0], res.max[1], res.max[2],
        );
        bridges.markDirtyByAABB(
          res.min[0], res.min[1], res.min[2],
          res.max[0], res.max[1], res.max[2],
        );
        vegetation.markDirtyByAABB(res.min[0], res.min[2], res.max[0], res.max[2]);
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
      aimSeg = aiming
        ? tunnels.nearestToRay(rayOrigin, rayDir, excavator.radius * 1.6, supLevel)
        : null;
      // 一人称では手の届く区間だけ。坑道の中で正面の 1 リングを狙う道具になる。
      // 少し甘く (REACH の 2 倍) しているのは、掘進中は切羽の手前を狙うため。
      if (aimSeg && fpv && aimSeg.pos.distanceTo(rayOrigin) > REACH * 2) aimSeg = null;

      if (aimSeg && held) {
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
    if (slopeLevel > 0 && held && hit) {
      if (!slopeWorks.paint(hit.point.x, hit.point.z, excavator.radius, slopeLevel, economy)) {
        const pv = slopeWorks.preview(hit.point.x, hit.point.z, excavator.radius, slopeLevel);
        if (pv.cost > economy.money) alerts.flash('資金が足りない');
      }
    }

    // --- ボーリング調査 ---
    if (tool === 'boring' && pressed && hit) {
      const b = survey.start(field, hit.point.x, hit.point.z, economy);
      if (!b) alerts.flash('調査を開始できない (資金不足)');
      else section.invalidate();
    }

    // --- 断面線 ---
    if (tool === 'section') {
      if (pressed && hit) section.setStart(hit.point);
      else if (held && hit) section.setEnd(hit.point);
    }

    // --- 路線 ---
    // 置くのは「通したい所」だけ。最小曲線半径と最大勾配を満たす中心線は
    // ここから解き直され、地形との差で区間の種別がひとりでに決まる。
    if (tool === 'align' && pressed && hit) {
      control.push({ x: hit.point.x, z: hit.point.z });
      alignDirty = true;
    }
  }

  if (alignDirty) replanRoad();

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
    bridges.markDirtyByAABB(
      slide.min[0], slide.min[1], slide.min[2],
      slide.max[0], slide.max[1], slide.max[2],
    );
    vegetation.markDirtyByAABB(slide.min[0], slide.min[2], slide.max[0], slide.max[2]);
    section.invalidate();
    slideVolume += repose.movedThisSlide;
  }
  // 崩れ切ったところで 1 回だけ知らせる。毎フレーム出すと読めない。
  if (!repose.active && slideVolume > 0) {
    if (slideVolume > 20) alerts.flash(`法面が崩れた — 土砂 ${slideVolume.toFixed(0)} m³ が動いた`);
    slideVolume = 0;
  }

  // 地形が動くのはここまで。掘って足元が消えた・崩落に埋められたのを、
  // 絵を出す前に同じフレームのうちに解く。1 フレーム遅らせると、
  // 埋まった瞬間の画がそのまま出てしまう。
  if (fpv) fp.player.resolve(field);

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
  // --- 橋: 支持力の再評価・劣化・落橋 ---
  // トンネルと同じ順序 (施工班のあと、描画の前) に置く。評価は真の場で行う。
  // 見積りは既知の情報だけで作っているので、ここで初めて食い違いが出る。
  bridges.update(trueGeoAt, groundAt, time.gameDelta);
  for (const b of bridges.newlyAtRisk) {
    alerts.flash(
      `⚠ 橋脚の支持力が足りない — ${b.plan.type.name} / ` +
      `あと ${Alerts.fmtHours(BridgeNetwork.hoursToFailure(b))}`,
    );
  }
  for (const c of bridges.recentCollapses) {
    tunnelView.burst(c.pos, c.bridge.width);
    alerts.flash('落橋 — 橋脚が沈下した');
    roadView.rebuildPaved(roads.roads);
  }
  roadView.syncBridges(bridges);
  if (roads.dirtyVisuals) {
    roads.dirtyVisuals = false;
    roadView.rebuildPaved(roads.roads);
  }
  roadView.update(time.realDelta);

  tunnelView.sync(tunnels);
  tunnelView.update(time.realDelta);
  alerts.update(tunnels, time.realDelta);

  // --- 調査 ---
  // 保護工の板は地表に載せているので、崩落で地形が動いたら作り直す
  if (slopeWorks.dirtyVisuals || slide) {
    slopeWorks.dirtyVisuals = false;
    slopeView.rebuild(heightIndex, slopeWorks);
  }

  // --- 植生 ---
  // 施工班 (crew) のあとに置く。種子吹付が入った列をその場で生え戻りへ回せる。
  // 整定より後でもあるので、崩れた列は同じフレームで裸になる。
  vegetation.update(heightIndex, time.gameDelta);
  if (vegOn) {
    // 草の房を実体で持つのは足元だけ。俯瞰で引いているときは 1 本も持たない
    // (1 本が 1 画素未満になる)。遠景の緑は被覆率マップの色が受け持つ。
    const close = fpv || engine.camera.position.distanceTo(rig.controls.target) < 45;
    vegView.sync(vegetation, heightIndex, fpv ? fp.player.pos : rig.controls.target, close);
    vegView.update(time.realDelta);
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

  // --- 路線ツール: 「規格が地形と何を約束したか」を数字で出す ---
  // 着工は取り返しがつかない (地形が変わる) ので、押す前に全部見えていること。
  if (tool === 'align') {
    rows.push(
      `<div class="row"><span class="k">規格</span><span class="v">${roadStd.name} — ` +
      `R ${roadStd.minRadius} m / ${(roadStd.maxGrade * 100).toFixed(0)} % / 幅 ${roadStd.width} m` +
      `</span></div>`,
    );
    if (!alignment || !roadPlan) {
      rows.push(
        '<div class="row"><span class="k">制御点</span>' +
        `<span class="v" style="color:#93a0b4">${control.length} 点 — 2 点以上で線が引ける</span></div>`,
      );
    } else {
      const al = alignment;
      const pv = roadPlan;
      const len = lengthByKind(al);
      rows.push(
        `<div class="row"><span class="k">延長</span><span class="v">${al.length.toFixed(0)} m ` +
        `(制御点 ${control.length})</span></div>`,
      );
      rows.push(
        `<div class="row"><span class="k">最小半径</span><span class="v"` +
        (al.minRadius < roadStd.minRadius * 0.99 ? ' style="color:#e8b45c"' : '') +
        `>${al.minRadius === Infinity ? '直線' : al.minRadius.toFixed(0) + ' m'}` +
        (al.maxOffset > 1
          ? ` <span style="color:#93a0b4">制御点から ${al.maxOffset.toFixed(0)} m</span>`
          : '') +
        `</span></div>`,
      );
      rows.push(
        `<div class="row"><span class="k">最大勾配</span>` +
        `<span class="v">${(al.maxGrade * 100).toFixed(1)} %</span></div>`,
      );
      const parts: string[] = [];
      for (const kind of [RoadKind.Cut, RoadKind.Fill, RoadKind.Tunnel, RoadKind.Bridge]) {
        if (len[kind] < 1) continue;
        parts.push(
          `<span style="color:${roadKindCss(kind)}">${ROAD_KIND_NAME[kind]} ${len[kind].toFixed(0)}</span>`,
        );
      }
      rows.push(
        `<div class="row"><span class="k">区分 [m]</span>` +
        `<span class="v">${parts.join(' / ') || '平坦のみ'}</span></div>`,
      );
      rows.push(
        `<div class="row"><span class="k">土工</span><span class="v">切 ${pv.cutVolume.toFixed(0)} / ` +
        `盛 ${pv.fillVolume.toFixed(0)} m³</span></div>`,
      );
      for (const b of pv.bridges) {
        rows.push(
          `<div class="row"><span class="k">橋</span><span class="v"` +
          (b.ok ? '' : ' style="color:#e8705a"') +
          `>${describeBridge(b)}</span></div>`,
        );
        const deep = b.piers.filter((p) => p.foundDepth > 0);
        if (deep.length > 0) {
          rows.push(
            `<div class="row"><span class="k"></span><span class="v" style="color:#93a0b4;font-size:11px">` +
            `深礎 ${deep.length} 基 / 最大 ${Math.max(...deep.map((p) => p.foundDepth)).toFixed(0)} m</span></div>`,
          );
        }
        // 未調査の所は「地表の地質が下まで続く」と決めてかかった数字なので、
        // それを隠さない。ここを黙ると、着工してから深礎が伸びる理由が分からない。
        const unsure = b.piers.filter(
          (p) => survey.confidenceAt(p.x, p.groundY - 1 - p.foundDepth, p.z) < 0.35,
        );
        if (unsure.length > 0) {
          rows.push(
            `<div class="row"><span class="k"></span><span class="v" style="color:#e8b45c;font-size:11px">` +
            `橋脚 ${unsure.length} 基が未調査 — 支持力は推定</span></div>`,
          );
        }
      }
      rows.push(
        `<div class="row"><span class="k">工費</span><span class="v"` +
        (pv.totalCost > economy.money ? ' style="color:#e8705a"' : '') +
        `>¥${Math.round(pv.totalCost).toLocaleString()}</span></div>`,
      );
      rows.push(
        `<div class="row"><span class="k"></span><span class="v" style="color:#93a0b4;font-size:11px">` +
        `土工 ${Math.round(pv.earthCost).toLocaleString()} / ` +
        `トンネル ${Math.round(pv.tunnelCost).toLocaleString()} / ` +
        `橋 ${Math.round(pv.bridgeCost).toLocaleString()} / ` +
        `舗装 ${Math.round(pv.paveCost).toLocaleString()}</span></div>`,
      );
      if (pv.problems.length > 0) {
        for (const p of pv.problems) {
          rows.push(
            `<div class="row"><span class="k" style="color:#e8705a">×</span>` +
            `<span class="v" style="color:#e8705a">${p}</span></div>`,
          );
        }
      } else {
        rows.push(
          '<div class="row"><span class="k">Enter</span>' +
          '<span class="v" style="color:#8fd0a0">着工</span></div>',
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

  if (fpv) {
    const p = fp.player.pos;
    rows.push(
      `<div class="row"><span class="k">現在地</span><span class="v">` +
      `${p.x.toFixed(0)}, ${p.z.toFixed(0)} / 標高 ${p.y.toFixed(1)} m</span></div>`,
    );
    if (tool !== 'look' && !hit) {
      rows.push(
        '<div class="row"><span class="k">正面</span>' +
        `<span class="v" style="color:#93a0b4">${REACH} m 以内に地面が無い</span></div>`,
      );
    }
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
      roads: RoadNetwork;
      bridges: BridgeNetwork;
      fp: FirstPerson;
      vegetation: Vegetation;
      /** テスト用: 視点を切り替える。一人称ならその場に立つ。 */
      setViewMode(mode: ViewMode): void;
      /** テスト用: 一人称で (x, z) へ立たせ、yaw / pitch を向ける。y を渡すとその高さから落とす。 */
      stand(x: number, z: number, yaw?: number, pitch?: number, y?: number): void;
      /** テスト用: 制御点を置いて線形を引き、そのまま着工する */
      road(points: [number, number][], stdId?: string): RoadPlan | null;
      /** テスト用: 着工せずに見積りだけ返す */
      previewRoad(points: [number, number][], stdId?: string): RoadPlan | null;
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
  repose, heightIndex, slopeInfoAt, slopeWorks, crew, roads, bridges,
  fp, vegetation,
  ready: true,
  setViewMode,
  stand(x, z, yaw = 0, pitch = 0, y) {
    setViewMode('fp');
    fp.player.placeAt(field, x, z);
    if (y !== undefined) {
      // 坑道の中に立たせたいときはここを使う。上から降ろすと山の上に乗る。
      fp.player.pos.y = y;
      fp.player.vel.set(0, 0, 0);
      fp.player.resolve(field);
    }
    fp.player.yaw = yaw;
    fp.player.pitch = pitch;
    fp.update(field, 0.016);
  },
  previewRoad(points, stdId) {
    control.length = 0;
    for (const p of points) control.push({ x: p[0], z: p[1] });
    if (stdId) roadStd = ROAD_STANDARDS.find((s) => s.id === stdId) ?? roadStd;
    replanRoad();
    return roadPlan;
  },
  road(points, stdId) {
    control.length = 0;
    for (const p of points) control.push({ x: p[0], z: p[1] });
    if (stdId) roadStd = ROAD_STANDARDS.find((s) => s.id === stdId) ?? roadStd;
    replanRoad();
    const plan = roadPlan;
    startRoad();
    repose.settleNow(field, chunks);
    chunks.update(100000);
    return plan;
  },
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
