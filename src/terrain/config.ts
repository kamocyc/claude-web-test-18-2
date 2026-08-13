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
 * **ゆるんだ土砂**が安定する角度 = 安息角 [度]。
 * 掘って崩した土、崩積土、盛土はこの角度まで寝る。
 *
 * 岩を「崩れない」という**別の規則**にはしていない。単に大きい値として
 * 同じ規則に乗せてある。例外を作ると、岩と土が混ざった法面で
 * どちらの規則が効くのかが説明できなくなる。
 *
 * 用地との引き換えが判断になる: 軟弱層は掘るのは速くて安いが、
 * 法面が寝るので切土の幅を食う。岩は逆。
 *
 * ---- 軟弱層が 30 度である理由 ----
 * 崩れて動いた土は元が何であれ軟弱層になる (Repose.ts) ので、この値は
 * 「軟弱層という地層の角度」であると同時に**あらゆる崩積土が最後に落ち着く
 * 角度**でもある。軟らかい粘性土・シルト単体なら 26 度でも妥当だが、
 * 崩積土の代表値としては低すぎる (現実のズリ山や崖錐は 35-40 度)。
 * 両方を 1 つの値で受け持たせる以上、中央寄りの 30 度にしてある。
 *
 * 高さ 10 m の法面に要る片側の幅: 岩 2.1 m / 土 14.8 m / 軟弱 17.3 m。
 * 水位下の軟弱層 (22 度) なら 24.8 m。
 */
export const REPOSE_DEG: Record<number, number> = {
  [Geo.Soil]: 34,
  [Geo.Rock]: 78,
  [Geo.Weak]: 30,
};

/**
 * **手つかずの原地盤**が自立できる角度 [度]。ほぼ垂直。
 *
 * 角度を 2 つ持つのは手抜きの逆で、1 つで済ませると成り立たない。
 * 安息角ひとつでやると、法尻をひと掘りしたときの後退量が
 *     法面高さ / (tan(安息角) - tan(自然斜面の角度))
 * になり、自然斜面が安息角に近いほど発散する。実測: 30 度の斜面の裾を
 * 1560 m^3 掘っただけで **41 m** 後退し、斜面がまるごと動いた。
 *
 * ---- なぜ「ほぼ垂直」なのか ----
 * この角度が受け持つのは「**掘っていない地面がどこまで巻き添えになるか**」
 * だけ。掘った所は掘った深さぶんがゆるみ土砂になり、必ず安息角まで寝るので、
 * 法面の見た目はこの値に依存しない。
 *
 * 中途半端な値 (58 度) にすると、斜面にトンネルを掘れなくなる。坑口の
 * 開いた区間は深さ 5.2 m の溝なので、その上流の地山が 5.2/(tan58-tan30)
 * = 5.1 m 後退する。掘進は 1.5 m/s なので**崩落前線が掘削ヘッドより先に進み**、
 * 土被りが付く前に天端が消える。実測 (30 度の斜面へ 15 m 掘進):
 *
 *   | 原地盤の角度 | 到達した土被り | 掘削量 | 動いた土量 |
 *   |---|---|---|---|
 *   | 58 度 | 0 m (トンネルにならない) | 1601 m^3 | 6872 m^3 |
 *   | 80 度 | 0 m | 828 m^3 | 1613 m^3 |
 *   | 85 度 | **5.7 m** | 459 m^3 | **62 m^3** |
 *
 * 「掘った所は寝る / 掘っていない所は動かない」と言い切れる値にしておくのが、
 * 説明としても挙動としてもいちばん素直だった。
 */
export const INSITU_DEG: Record<number, number> = {
  [Geo.Soil]: 85,
  [Geo.Rock]: 88,
  [Geo.Weak]: 80,
};

/** 地下水位より下は飽和して角度が落ちる [度]。軟弱層の安息角なら 22 度まで寝る。 */
export const REPOSE_SATURATED_DROP = 8;

/**
 * 掘削がゆるませる厚みの上限 [m]。
 *
 * ゆるむ厚みは「その列で実際に地表が下がった量」なので、普通はこの上限に
 * 当たらない。当たるのは、同じ所を何度も掘り下げ続けたときだけ。
 * 暴走の歯止めとして置いてあるだけで、調整ダイヤルではない。
 */
export const LOOSEN_MAX_DEPTH = 8;

/**
 * 空洞の天端に残す最低土被り [m]。整定はここより下を削らない。
 *
 * これが無いと、法面が崩れて坑道の天端を破った瞬間に列の地表が
 * 坑道の床まで落ち、山腹がまるごと坑道へ流れ込む。
 * 天端が薄くなったこと自体は Tunnel 側が土被りとして読み、
 * 必要支保が上がって崩落するかどうかはそちらが決める。持ち場を分ける。
 */
export const ROOF_KEEP = 1.0;

/** 耐力 (橋脚用。第 2 弾で使う)。軟弱層はほぼゼロ。 */
export const GEO_BEARING: Record<number, number> = {
  [Geo.Soil]: 2,
  [Geo.Rock]: 3,
  [Geo.Weak]: 0.05,
};
