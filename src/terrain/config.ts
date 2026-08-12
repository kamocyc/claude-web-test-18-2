/**
 * 地形の解像度・寸法の一元定義。
 * ここだけ触ればワールドサイズと精度を振れる。
 */

/** セル間隔 [m]。小さいほど細かいが、メモリは 3 乗で効く。 */
export const CELL = 0.5;

/** ワールドのセル数 (各軸)。ノード数は +1。チャンクサイズの倍数であること。 */
export const CELLS_X = 256;
export const CELLS_Y = 128;
export const CELLS_Z = 256;

/** 密度・地質を格納するノード数 (格子点。セル数 + 1)。 */
export const NX = CELLS_X + 1;
export const NY = CELLS_Y + 1;
export const NZ = CELLS_Z + 1;

/** ワールドの実寸 [m]。128 x 64 x 128 */
export const WORLD_X = CELLS_X * CELL;
export const WORLD_Y = CELLS_Y * CELL;
export const WORLD_Z = CELLS_Z * CELL;

/** チャンクの一辺 [セル]。32 セル = 16 m 立方。 */
export const CHUNK = 32;

export const CHUNKS_X = CELLS_X / CHUNK;
export const CHUNKS_Y = CELLS_Y / CHUNK;
export const CHUNKS_Z = CELLS_Z / CHUNK;
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z;

/** 地下水位 [m]。企画どおり「水平な一本の線」なのでスカラー 1 個で足りる。 */
export const WATER_TABLE_Y = 17.5;

/** 地質 ID。企画の 3 種類のみ。 */
export const enum Geo {
  Soil = 0,
  Rock = 1,
  Weak = 2,
}

export const GEO_COUNT = 3;

export const GEO_NAME_JA: Record<number, string> = {
  [Geo.Soil]: '土',
  [Geo.Rock]: '岩',
  [Geo.Weak]: '軟弱層',
};

/** 露出面の基本色。企画の「色を見れば分かる」の根拠。茶 / 灰 / 黄。 */
export const GEO_COLOR: Record<number, [number, number, number]> = {
  [Geo.Soil]: [0.40, 0.27, 0.15],
  [Geo.Rock]: [0.32, 0.33, 0.35],
  [Geo.Weak]: [0.70, 0.58, 0.17],
};

/**
 * 掘削速度 [m^3/s]。岩は遅く、軟弱層は速い。手応えで地質が分かるようにする。
 *
 * ヘッドの進む速さは 掘削速度 / 断面積 なので、半径 2.6 m のブラシだと
 * 土 1.5 / 岩 0.38 / 軟弱 2.1 m/s。
 * ここが遅すぎると、土被りがつくまで 20 m 掘るのに 30 秒ドラッグし続ける羽目になり、
 * 「掘っているのにいつまでもトンネルにならない」になる。実際そうなっていた。
 * 比 (岩は土の 1/4、軟弱は土の 1.4 倍) は維持すること。
 */
export const DIG_RATE: Record<number, number> = {
  [Geo.Soil]: 32.0,
  [Geo.Rock]: 8.0,
  [Geo.Weak]: 45.0,
};

/** 掘削単価 [金/m^3]。 */
export const DIG_COST: Record<number, number> = {
  [Geo.Soil]: 2,
  [Geo.Rock]: 9,
  [Geo.Weak]: 1,
};

/** 必要支保レベル (地質由来)。水位より下ならさらに +1。 */
export const GEO_SUPPORT_REQ: Record<number, number> = {
  [Geo.Soil]: 1,
  [Geo.Rock]: 0,
  [Geo.Weak]: 2,
};

/**
 * 安息角 [度]。これより急な法面は自重で崩れて、この角度まで寝る。
 *
 * 岩を 78 度にしてあるのは「岩は崩れない」を別の規則として書きたくないから。
 * 同じ規則の中で桁違いに大きい値を持たせれば、切土がほぼ直立のまま立つ。
 * 実際の岩盤法面 (1:0.3 = 73 度) より少し急なだけで、桁外れの嘘ではない。
 *
 * この 3 つの差がそのまま地上の判断になる。岩は法面が狭くて済むが掘るのが高い、
 * 軟弱層は掘るのは安いが法面が寝て用地と手間を食う。
 */
export const REPOSE_DEG: Record<number, number> = {
  [Geo.Soil]: 34,
  [Geo.Rock]: 78,
  [Geo.Weak]: 26,
};

/** 地下水位より下は飽和して安息角が落ちる [度]。軟弱層なら 18 度まで寝る。 */
export const REPOSE_SATURATED_DROP = 8;

/** 耐力 (橋脚用。第 2 弾で使う)。軟弱層はほぼゼロ。 */
export const GEO_BEARING: Record<number, number> = {
  [Geo.Soil]: 2,
  [Geo.Rock]: 3,
  [Geo.Weak]: 0.05,
};
