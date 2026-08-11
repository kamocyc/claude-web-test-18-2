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
  [Geo.Soil]: [0.42, 0.29, 0.17],
  [Geo.Rock]: [0.44, 0.45, 0.47],
  [Geo.Weak]: [0.76, 0.66, 0.24],
};

/** 掘削速度 [m^3/s]。岩は遅く、軟弱層は速い。手応えで地質が分かるようにする。 */
export const DIG_RATE: Record<number, number> = {
  [Geo.Soil]: 6.0,
  [Geo.Rock]: 1.6,
  [Geo.Weak]: 9.0,
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

/** 耐力 (橋脚用。第 2 弾で使う)。軟弱層はほぼゼロ。 */
export const GEO_BEARING: Record<number, number> = {
  [Geo.Soil]: 2,
  [Geo.Rock]: 3,
  [Geo.Weak]: 0.05,
};
