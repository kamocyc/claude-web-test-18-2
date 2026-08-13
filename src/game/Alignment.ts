/**
 * 線形 (アライメント)。制御点から**規格を満たす中心線**を作る。
 *
 * 道路や鉄道が地形と噛み合うのは、線形が地形に従うからではなく、
 * 線形のほうに「これ以上は曲がれない / 登れない」という規格があり、
 * 従えない所を切土・盛土・トンネル・橋で埋めるからで、その順序が逆になると
 * ただの「地面をなぞる帯」になって判断が何も生まれない。
 * だからここでは**先に規格を満たす線を引き、地形との差を後で読む**。
 *
 * ---- なぜ制約を「解く」のか ----
 * 安息角 (Repose.ts) と同じ考え方にしてある。欲しいのは
 *
 *     平面: |曲率| <= 1/Rmin
 *     縦断: |dy/ds| <= imax  かつ  |d^2y/ds^2| <= 1/Rv
 *
 * という制約そのもので、これを直接解けば停留点が定義から
 * 「規格を満たすいちばん素直な線」になる。制御点をベジエやスプラインで
 * 繋いでから曲率を**測って警告する**方式も試したが、警告を見た人間が
 * 制御点をずらして測り直す作業に化けるだけで、規格が線形を作る力にならない。
 * ずらすのは計算機の仕事にする。
 *
 * 平面と縦断で解き方が違うのは、制約の性質が違うため。
 *   - 縦断の制約は y についての**線形不等式**なので凸。最小ノルム補正を
 *     交互に当てれば (POCS) 必ず実行可能点へ収束する。
 *   - 平面の曲率制約は非凸なので、そういう保証は無い。代わりに
 *     「違反した頂点だけを中点へ寄せる」= 曲率を単調に減らす操作を繰り返す。
 *     矢 (sagitta) が 1/R に比例するので、R/Rmin の比だけ矢を縮めれば
 *     1 回で規格に乗る。実測では 128 m 四方の世界で 40 回未満で収まる。
 *
 * 収束しきらなかったときに黙って規格外の線を返さないこと。
 * 実現した最小半径・最大勾配を必ず返し、UI がそれを出す。
 * 「制御点が急すぎて入らなかった」は隠すべき失敗ではなく、
 * **制御点を動かせという指示**そのもの。
 */

/** 中心線を刻む間隔 [m]。トンネルの SEGMENT_LENGTH と同じ値にしてある。 */
export const STATION_STEP = 2.0;

export interface Vec2 {
  x: number;
  z: number;
}

/**
 * 道路規格。「曲げられない・登れない」の程度そのもの。
 *
 * 2 つあるのは、どちらを選ぶかが土工量に直結するから。山岳道路は地形に
 * 沿えるので切土も橋も少なくて済むが、幅が狭く舗装も安普請。標準道路は
 * 曲がれないぶん尾根を切り、谷を跨ぐことになる。
 * 実寸 128 m 四方の世界なので、値は実際の道路規格 (第 3 種第 4 級で
 * R = 60 m / i = 8 %) より一回り小さく取ってある。
 */
export interface RoadStandard {
  id: 'mountain' | 'standard';
  name: string;
  /** 最小曲線半径 [m]。 */
  minRadius: number;
  /** 最大縦断勾配 [-]。 */
  maxGrade: number;
  /** 縦断曲線半径 [m]。勾配が変化してよい速さの上限。 */
  vertRadius: number;
  /** 路面幅 (路肩込み) [m]。切盛の幅と舗装費に効く。 */
  width: number;
  /** 舗装単価 [円/m^2]。 */
  paveCost: number;
  /** 舗装の施工時間 [ゲーム内時間/m^2]。 */
  paveHours: number;
}

export const ROAD_STANDARDS: RoadStandard[] = [
  {
    id: 'mountain',
    name: '山岳道路',
    minRadius: 18,
    maxGrade: 0.10,
    vertRadius: 160,
    width: 6.5,
    paveCost: 55,
    paveHours: 0.004,
  },
  {
    id: 'standard',
    name: '標準道路',
    minRadius: 45,
    maxGrade: 0.06,
    vertRadius: 420,
    width: 9,
    paveCost: 95,
    paveHours: 0.006,
  },
];

/** 区間の種別。地形との差だけで決まる。 */
export const enum RoadKind {
  Flat = 0,
  Cut = 1,
  Fill = 2,
  Tunnel = 3,
  Bridge = 4,
}

export const ROAD_KIND_NAME: Record<number, string> = {
  [RoadKind.Flat]: '平坦',
  [RoadKind.Cut]: '切土',
  [RoadKind.Fill]: '盛土',
  [RoadKind.Tunnel]: 'トンネル',
  [RoadKind.Bridge]: '橋',
};

/**
 * この高さを超える盛土は**橋にする** [m]。
 *
 * 盛土は高さ H に対して片側 H/tan(安息角) の用地を食うので、H = 9 m の
 * 盛土は土なら片側 13 m、軟弱層なら 16 m 広がる。谷を土で埋めるより
 * 桁を架けたほうが安くなる境目がこのあたり。
 */
const FILL_MAX = 9;

/**
 * この深さを超える切土は**トンネルにする** [m] の下限。
 * 盛土より深めに取ってあるのは、切土のほうが (掘った土が盛土に回るので)
 * 経済的に有利なため。
 */
const CUT_MAX_MIN = 12;

/**
 * トンネルにする切土深さ / トンネル断面の半径。
 *
 * ここを固定値 (12 m) にしていると、**掘ったのにトンネルとして登録されない**
 * 区間ができる。坑道の天端は路面から 1.25 R 上にあり
 * (`Roadworks.BORE_CENTER_RATIO`)、トンネル成立にはさらに 1.2 R の土被りが
 * 要る (`Tunnel.COVER_TUNNEL_MIN`) ので、合わせて 2.45 R 必要。
 * 幅 9 m の道路なら R = 6.1 m なので 15.0 m で、12 m では足りない。
 * 実測では 22 m のトンネル区間を掘って**区間が 0 本**、つまり支保も崩落も
 * 掛からない大穴が地表近くに開いた。
 *
 * 余裕を見て 2.85 倍 (山岳 13.8 m / 標準 17.4 m)。これを下回る深さは、
 * 掘っても土被りが付かない = ただの深い切土なので、切土と呼ぶのが正しい。
 * **この値を下げて「トンネルが出やすい」ようにしてはいけない。**
 * 出るのは支保の掛からない大穴で、トンネルではない。
 */
const TUNNEL_COVER_FACTOR = 2.85;

/**
 * トンネル断面の半径 [m]。路面幅に建築限界を足したもの。
 * 分類 (ここ) と実際の掘削 (Roadworks) で必ず同じ値を使うこと。
 * ずれると「トンネルと言われた区間を掘っても土被りが付かない」が起きる。
 */
export function tunnelRadius(std: RoadStandard): number {
  return std.width / 2 + 1.6;
}

/** これ以下の差は「平坦」として扱う [m]。 */
const FLAT_EPS = 0.7;

/**
 * 橋・トンネルとして成立させる最小延長 [m]。
 *
 * これが無いと、谷底の小さな起伏で「2 m の橋」「4 m のトンネル」が
 * 点々と並ぶ。橋台とトンネル坑口はそれ自体が高い構造物なので、
 * 短すぎるものは切盛に均したほうが必ず安い。
 */
const MIN_STRUCT_LEN = 12;

/** 平面の緩和の上限回数。収束の番人であって調整ダイヤルではない。 */
const MAX_RELAX = 600;
/** 中点へ寄せる量の減衰。1.0 だと隣の頂点と押し合って振動する。 */
const RELAX_DAMP = 0.65;
/** 平面の緩和と等間隔化を何往復するか。 */
const RELAX_ROUNDS = 8;
/**
 * 緩和が狙う半径の割増し。
 * 弧長で打ち直すと、詰まっていた頂点がずれて曲率がわずかに戻る。
 * 規格ちょうどを狙うと打ち直しのたびに下回るので、少し余分に伸ばしておく。
 */
const RELAX_TARGET = 1.06;

/** 縦断: 地盤へ引く強さ。大きいほど地形に沿い、土工量が減るが波打つ。 */
const PROFILE_PULL = 0.25;
/** 縦断: 引いたあとに制約へ戻す回数。 */
const PROFILE_ITERS = 120;
const PROJ_PASSES = 6;
/**
 * 縦断: 最後に制約だけを詰める回数の上限。
 * 交互射影は線形収束なので、回数ではなく**残差**で打ち切る。回数を決め打ちに
 * すると、測点が増えたときに黙って規格外の縦断が返る
 * (実測: 80 測点 / 400 回で 2.8 % 超過)。
 */
const FINAL_PASSES = 20000;
/** 縦断: 制約の残差がこれ以下になったら実行可能とみなす [m]。 */
const PROFILE_TOL = 1e-7;
/**
 * 縦断: 射影の緩和係数 (SOR)。Agmon-Motzkin の緩和法なので (0, 2) が使える。
 *
 * 勾配と縦断曲線の補正は互いを少しずつ壊し合うので、素の射影 (omega = 1) だと
 * 情報が 1 スイープに 1 測点しか伝わらず、80 測点で 10 万スイープ掛かった。
 * 往復スイープにして 5 万、omega = 1.9 で **4,779 スイープ / 8.8 ms**。
 * 収束先は変わらない (実測の超過 0.0002 %)。
 */
const PROFILE_OMEGA = 1.9;
/**
 * 縦断: 詰めの段階で制約をこれだけきつく取る。
 *
 * 交互射影は規格ちょうどの面へ**外側から**漸近するので、そのままだと
 * 「ほぼ満たす」しか言えない。詰めだけ 0.1 % きつい面へ落とせば、
 * 残差はその内側に収まって**必ず規格内**になる。
 */
const PROFILE_SLACK = 0.999;

export interface Station {
  /** 起点からの距離 [m]。 */
  s: number;
  x: number;
  z: number;
  /** 計画高 [m]。 */
  y: number;
  /** 地盤高 [m]。 */
  ground: number;
  /** 水平接線 (単位ベクトル)。 */
  dirX: number;
  dirZ: number;
  /** 縦断勾配 [-]。 */
  grade: number;
  /** 曲線半径 [m]。直線は Infinity。 */
  radius: number;
  kind: RoadKind;
}

export interface Alignment {
  std: RoadStandard;
  stations: Station[];
  /** 総延長 [m]。 */
  length: number;
  /** 実現した最小曲線半径 [m]。 */
  minRadius: number;
  /** 実現した最大縦断勾配 [-]。 */
  maxGrade: number;
  /** 制御点から中心線までの最大のずれ [m]。規格が制御点を押し返した量。 */
  maxOffset: number;
  /** 規格を満たしているか。満たせなかったら制御点を動かすしかない。 */
  ok: boolean;
}

// --------------------------------------------------------------- 平面 (曲線)

/** 3 点の外接円半径。直線 (面積 0) は Infinity。 */
export function circumRadius(a: Vec2, b: Vec2, c: Vec2): number {
  const abx = b.x - a.x, abz = b.z - a.z;
  const bcx = c.x - b.x, bcz = c.z - b.z;
  const cax = a.x - c.x, caz = a.z - c.z;
  const cross = abx * bcz - abz * bcx;
  const area2 = Math.abs(cross);
  if (area2 < 1e-12) return Infinity;
  const ab = Math.hypot(abx, abz);
  const bc = Math.hypot(bcx, bcz);
  const ca = Math.hypot(cax, caz);
  return (ab * bc * ca) / (2 * area2);
}

/**
 * 制御点を Catmull-Rom (centripetal) で繋いで密にサンプルする。
 *
 * centripetal (alpha = 0.5) を使うのは、一様パラメータ化だと制御点の間隔が
 * 偏ったときにループやカスプが出るため。カスプは曲率が無限大なので、
 * このあとの曲率制約が延々と潰しにかかって形が壊れる。
 */
function sampleCatmullRom(pts: readonly Vec2[], step: number): Vec2[] {
  if (pts.length < 2) return pts.map((p) => ({ x: p.x, z: p.z }));

  const out: Vec2[] = [];
  const n = pts.length;
  const at = (i: number): Vec2 => pts[Math.max(0, Math.min(n - 1, i))];

  for (let i = 0; i < n - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);

    // centripetal のノット
    const t = [0, 0, 0, 0];
    const knot = (a: Vec2, b: Vec2): number =>
      Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)) || 1e-4;
    t[1] = t[0] + knot(p0, p1);
    t[2] = t[1] + knot(p1, p2);
    t[3] = t[2] + knot(p2, p3);

    const span = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(2, Math.ceil(span / Math.max(0.25, step)));
    for (let m = 0; m < steps; m++) {
      const u = t[1] + ((t[2] - t[1]) * m) / steps;
      out.push(barry(p0, p1, p2, p3, t, u));
    }
  }
  out.push({ x: pts[n - 1].x, z: pts[n - 1].z });
  return out;
}

/** Barry-Goldman の再帰。centripetal Catmull-Rom の素直な評価。 */
function barry(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number[], u: number): Vec2 {
  const lerp = (a: Vec2, b: Vec2, t0: number, t1: number): Vec2 => {
    const d = t1 - t0;
    const w = d === 0 ? 0 : (u - t0) / d;
    return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
  };
  const a1 = lerp(p0, p1, t[0], t[1]);
  const a2 = lerp(p1, p2, t[1], t[2]);
  const a3 = lerp(p2, p3, t[2], t[3]);
  const b1 = lerp(a1, a2, t[0], t[2]);
  const b2 = lerp(a2, a3, t[1], t[3]);
  return lerp(b1, b2, t[1], t[2]);
}

/** 折れ線を弧長で等間隔に打ち直す。 */
export function resampleUniform(poly: readonly Vec2[], step: number): Vec2[] {
  if (poly.length < 2) return poly.map((p) => ({ x: p.x, z: p.z }));

  const out: Vec2[] = [{ x: poly[0].x, z: poly[0].z }];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg < 1e-9) continue;
    let d = step - carry;
    while (d <= seg) {
      const w = d / seg;
      out.push({ x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w });
      d += step;
    }
    carry = seg - (d - step);
  }
  const last = poly[poly.length - 1];
  const tail = out[out.length - 1];
  // 末端は必ず載せる。ただし直前の点と近すぎると曲率が暴れるので、
  // 半刻み未満なら差し替える。
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.5) {
    out.push({ x: last.x, z: last.z });
  } else if (out.length > 1) {
    tail.x = last.x;
    tail.z = last.z;
  }
  return out;
}

/**
 * 曲率制約への緩和。違反した頂点だけを両隣の中点へ寄せる。
 *
 * 円弧の矢 (中点からのずれ) は弦長を h として h^2/(8R) なので、矢を R/Rmin 倍に
 * 縮めれば半径は Rmin になる。つまり寄せる割合は 1 - R/Rmin でよく、
 * 「少しずつ均す」必要が無い。減衰を掛けてあるのは、隣り合う違反頂点が
 * 互いの中点を動かし合って振動するのを避けるためだけ。
 *
 * 両端は動かさない。動かすと、制御点を 2 つ置いただけの直線が縮む。
 */
function limitCurvature(pts: Vec2[], minRadius: number): void {
  const n = pts.length;
  if (n < 3) return;
  for (let it = 0; it < MAX_RELAX; it++) {
    let violated = false;
    for (let i = 1; i < n - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const r = circumRadius(a, b, c);
      if (r >= minRadius) continue;
      violated = true;
      const lam = RELAX_DAMP * (1 - r / minRadius);
      b.x += ((a.x + c.x) * 0.5 - b.x) * lam;
      b.z += ((a.z + c.z) * 0.5 - b.z) * lam;
    }
    if (!violated) return;
  }
}

/** 折れ線の最小曲線半径 [m]。 */
export function measureMinRadius(pts: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const r = circumRadius(pts[i - 1], pts[i], pts[i + 1]);
    if (r < best) best = r;
  }
  return best;
}

// --------------------------------------------------------------- 縦断 (勾配)

/**
 * 縦断線形。地盤高 `ground` になるべく沿いつつ、勾配と縦断曲線の制約を満たす
 * 高さの列を返す。
 *
 * 制約はどちらも y についての線形不等式なので、最小ノルム補正を交互に
 * 当てるだけで実行可能集合へ収束する (POCS)。「地盤へ引く」ステップと
 * 交互にすると、制約を満たす中で土工量がいちばん小さい所へ落ち着く。
 *
 * **両端は固定しない。** 固定すると、尾根の上と谷底を選んだだけで
 * |Δy| > 延長 * imax になり、実行可能集合が空になって解が存在しなくなる。
 * 端も他の点と同じく地盤へ引かれるだけにしておけば、必ず解がある。
 */
export function solveProfile(
  ground: readonly number[],
  step: number,
  std: RoadStandard,
): number[] {
  const n = ground.length;
  const y = Array.from(ground);
  if (n < 3) return y;

  /** 隣の測点との高低差の上限 [m]。 */
  const gLim = std.maxGrade * step;
  /** 2 階差分の上限 [m]。縦断曲線半径 Rv の定義そのもの。 */
  const cLim = (step * step) / std.vertRadius;

  /** 勾配 |y[i+1] - y[i]| <= g への最小ノルム補正。a = (-1, 1) なので |a|^2 = 2。 */
  const grade = (i: number, g: number): number => {
    const d = y[i + 1] - y[i];
    const ex = d > g ? d - g : d < -g ? d + g : 0;
    if (ex === 0) return 0;
    const w = ex * 0.5 * PROFILE_OMEGA;
    y[i] += w;
    y[i + 1] -= w;
    return Math.abs(ex);
  };

  /** 縦断曲線 |y[i-1] - 2y[i] + y[i+1]| <= c への補正。a = (1, -2, 1) なので |a|^2 = 6。 */
  const curve = (i: number, c: number): number => {
    const v = y[i - 1] - 2 * y[i] + y[i + 1];
    const ex = v > c ? v - c : v < -c ? v + c : 0;
    if (ex === 0) return 0;
    const w = (ex / 6) * PROFILE_OMEGA;
    y[i - 1] -= w;
    y[i] += 2 * w;
    y[i + 1] -= w;
    return Math.abs(ex);
  };

  /**
   * 1 巡。**往復させる**のが効く。片道だけだと補正が 1 スイープに 1 測点しか
   * 伝わらず、収束に 2 倍のスイープが要る。
   * @returns この 1 巡で見つかった最大の超過 [m]。
   */
  const project = (scale = 1): number => {
    const g = gLim * scale;
    const c = cLim * scale;
    let worst = 0;
    for (let i = 0; i + 1 < n; i++) worst = Math.max(worst, grade(i, g));
    for (let i = 1; i + 1 < n; i++) worst = Math.max(worst, curve(i, c));
    for (let i = n - 2; i >= 1; i--) worst = Math.max(worst, curve(i, c));
    for (let i = n - 2; i >= 0; i--) worst = Math.max(worst, grade(i, g));
    return worst;
  };

  for (let it = 0; it < PROFILE_ITERS; it++) {
    for (let i = 0; i < n; i++) y[i] += (ground[i] - y[i]) * PROFILE_PULL;
    for (let p = 0; p < PROJ_PASSES; p++) project();
  }
  // 引き寄せで破った分を最後に戻す。ここを省くと規格外の縦断が返る。
  for (let p = 0; p < FINAL_PASSES; p++) {
    if (project(PROFILE_SLACK) <= PROFILE_TOL) break;
  }
  return y;
}

// --------------------------------------------------------------- 区間の分類

/**
 * 地形との差だけで区間を分ける。**構造物の種類を先に決めない。**
 *
 * 「ここはトンネル」と宣言してから地面を見るのではなく、規格を満たす線を
 * 引いた結果として地面が上に来ていればトンネル、下に離れていれば橋になる。
 * だから制御点を 1 つ動かすと種別がひとりでに入れ替わる。
 */
function classify(stations: Station[], step: number, std: RoadStandard): void {
  const cutMax = Math.max(CUT_MAX_MIN, TUNNEL_COVER_FACTOR * tunnelRadius(std));
  for (const st of stations) {
    const d = st.y - st.ground;
    if (d > FILL_MAX) st.kind = RoadKind.Bridge;
    else if (d < -cutMax) st.kind = RoadKind.Tunnel;
    else if (Math.abs(d) < FLAT_EPS) st.kind = RoadKind.Flat;
    else if (d > 0) st.kind = RoadKind.Fill;
    else st.kind = RoadKind.Cut;
  }

  // 短すぎる橋 / トンネルは切盛に均す。橋台も坑口もそれ自体が高いので、
  // 短いものは必ず切盛のほうが安い。
  const minRun = Math.max(2, Math.round(MIN_STRUCT_LEN / step));
  for (let i = 0; i < stations.length; ) {
    const kind = stations[i].kind;
    let j = i;
    while (j < stations.length && stations[j].kind === kind) j++;
    if ((kind === RoadKind.Bridge || kind === RoadKind.Tunnel) && j - i < minRun) {
      for (let m = i; m < j; m++) {
        const st = stations[m];
        const d = st.y - st.ground;
        st.kind = Math.abs(d) < FLAT_EPS
          ? RoadKind.Flat
          : d > 0 ? RoadKind.Fill : RoadKind.Cut;
      }
    }
    i = j;
  }

  // 逆に、橋 (トンネル) に挟まれた短い切盛は構造物に取り込む。
  // 橋の途中で 6 m だけ盛土に落ちると、橋台を 2 組建てて盛土を挟むことになり、
  // 通しで架けるより高くつくうえ見た目も破綻する。
  for (const target of [RoadKind.Bridge, RoadKind.Tunnel] as const) {
    for (let i = 0; i < stations.length; ) {
      if (stations[i].kind !== target) { i++; continue; }
      let j = i;
      while (j < stations.length && stations[j].kind === target) j++;
      // j はこの構造物の終わり。次の構造物までの隙間を測る。
      let k = j;
      while (k < stations.length && stations[k].kind !== target) k++;
      if (k < stations.length && k - j < minRun) {
        for (let m = j; m < k; m++) stations[m].kind = target;
        continue; // i は動かさず、繋がった区間として測り直す
      }
      i = j;
    }
  }
}

// --------------------------------------------------------------- 組み立て

/**
 * 制御点から線形を作る。
 *
 * @param control 制御点 (平面座標)。2 点未満なら空の線形を返す。
 * @param groundAt 地盤高を返す関数。terrain 層を game 層から切り離すために
 *                 関数で受ける (このモジュールは純粋なので単体で試験できる)。
 */
export function buildAlignment(
  control: readonly Vec2[],
  groundAt: (x: number, z: number) => number,
  std: RoadStandard,
  step = STATION_STEP,
): Alignment {
  const empty: Alignment = {
    std, stations: [], length: 0,
    minRadius: Infinity, maxGrade: 0, maxOffset: 0, ok: true,
  };
  if (control.length < 2) return empty;

  // 1) 制御点を滑らかに繋ぎ、弧長で等間隔に打つ
  let poly = resampleUniform(sampleCatmullRom(control, step * 0.5), step);
  if (poly.length < 2) return empty;

  // 2) 曲率制約へ緩和する。緩和すると間隔が詰まるので、等間隔化と往復させる。
  //    打ち直しで曲率がわずかに戻るぶん、狙いを少し甘く (半径を大きめに) 取る。
  for (let r = 0; r < RELAX_ROUNDS; r++) {
    limitCurvature(poly, std.minRadius * RELAX_TARGET);
    poly = resampleUniform(poly, step);
    if (measureMinRadius(poly) >= std.minRadius) break;
  }
  const minRadius = measureMinRadius(poly);

  // 3) 地盤を読んで縦断を解く
  const ground = poly.map((p) => groundAt(p.x, p.z));
  const y = solveProfile(ground, step, std);

  // 4) 測点を組み立てる
  const stations: Station[] = [];
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    if (i > 0) s += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].z - poly[i - 1].z);
    const a = poly[Math.max(0, i - 1)];
    const b = poly[Math.min(poly.length - 1, i + 1)];
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    const gA = y[Math.max(0, i - 1)];
    const gB = y[Math.min(y.length - 1, i + 1)];
    const ds = (Math.min(poly.length - 1, i + 1) - Math.max(0, i - 1)) * step;
    stations.push({
      s,
      x: poly[i].x,
      z: poly[i].z,
      y: y[i],
      ground: ground[i],
      dirX: tx / tl,
      dirZ: tz / tl,
      grade: ds > 0 ? (gB - gA) / ds : 0,
      radius: i > 0 && i < poly.length - 1
        ? circumRadius(poly[i - 1], poly[i], poly[i + 1])
        : Infinity,
      kind: RoadKind.Flat,
    });
  }
  classify(stations, step, std);

  let maxGrade = 0;
  for (const st of stations) maxGrade = Math.max(maxGrade, Math.abs(st.grade));

  // 制御点からどれだけ押し戻されたか。「曲がれないので離れた」量そのもの。
  let maxOffset = 0;
  for (const c of control) {
    let d = Infinity;
    for (const p of poly) d = Math.min(d, Math.hypot(p.x - c.x, p.z - c.z));
    maxOffset = Math.max(maxOffset, d);
  }

  return {
    std,
    stations,
    length: s,
    minRadius,
    maxGrade,
    maxOffset,
    // 丸め誤差ぶんの余裕を見る。1 % 未満のはみ出しは規格内として扱う。
    ok: minRadius >= std.minRadius * 0.99 && maxGrade <= std.maxGrade * 1.01,
  };
}

/** 種別ごとの延長 [m]。HUD と積算に使う。 */
export function lengthByKind(al: Alignment, step = STATION_STEP): Record<number, number> {
  const out: Record<number, number> = {
    [RoadKind.Flat]: 0, [RoadKind.Cut]: 0, [RoadKind.Fill]: 0,
    [RoadKind.Tunnel]: 0, [RoadKind.Bridge]: 0,
  };
  for (const st of al.stations) out[st.kind] += step;
  return out;
}

/** 同じ種別が続く区間を [開始添字, 終了添字) で列挙する。 */
export function runsOf(al: Alignment, kind: RoadKind): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < al.stations.length; ) {
    if (al.stations[i].kind !== kind) { i++; continue; }
    let j = i;
    while (j < al.stations.length && al.stations[j].kind === kind) j++;
    out.push([i, j]);
    i = j;
  }
  return out;
}
