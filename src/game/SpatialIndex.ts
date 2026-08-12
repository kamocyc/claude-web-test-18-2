/**
 * 一様ハッシュグリッド。ワールド AABB から、そこに関係する構造物 ID を引く。
 *
 * 企画の「崩落が起きるのは、あくまで後から地面のほうが変わったとき」を
 * 効率よく成立させるための仕掛け。地形を編集すると Edit.ts が影響 AABB を返すので、
 * それでここを引き、当たった構造物だけを再評価キューに積む。
 * 毎フレーム全構造物を舐める必要がない。
 */
export class SpatialIndex {
  private cells = new Map<number, Set<number>>();
  /** 構造物 ID → 登録済みセルキー。登録解除に使う。 */
  private owned = new Map<number, number[]>();

  constructor(private cellSize = 8) {}

  private key(cx: number, cy: number, cz: number): number {
    // ワールドは 128x64x128 m。8 m セルなら各軸 16 なので 6 bit あれば足りるが、
    // 余裕を見て 10 bit ずつ取る。
    return ((cx & 1023) << 20) | ((cy & 1023) << 10) | (cz & 1023);
  }

  private *keysFor(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): Generator<number> {
    const s = this.cellSize;
    const c0x = Math.floor(minX / s);
    const c0y = Math.floor(minY / s);
    const c0z = Math.floor(minZ / s);
    const c1x = Math.floor(maxX / s);
    const c1y = Math.floor(maxY / s);
    const c1z = Math.floor(maxZ / s);
    for (let cz = c0z; cz <= c1z; cz++)
      for (let cy = c0y; cy <= c1y; cy++)
        for (let cx = c0x; cx <= c1x; cx++)
          yield this.key(cx, cy, cz);
  }

  /** 構造物を影響 AABB で登録する。既存の登録は置き換える。 */
  insert(
    id: number,
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
  ): void {
    this.remove(id);
    const keys: number[] = [];
    for (const k of this.keysFor(minX, minY, minZ, maxX, maxY, maxZ)) {
      let set = this.cells.get(k);
      if (!set) {
        set = new Set();
        this.cells.set(k, set);
      }
      set.add(id);
      keys.push(k);
    }
    this.owned.set(id, keys);
  }

  remove(id: number): void {
    const keys = this.owned.get(id);
    if (!keys) return;
    for (const k of keys) {
      const set = this.cells.get(k);
      if (!set) continue;
      set.delete(id);
      if (set.size === 0) this.cells.delete(k);
    }
    this.owned.delete(id);
  }

  /** AABB に触れる構造物 ID を out に集める。 */
  query(
    minX: number, minY: number, minZ: number,
    maxX: number, maxY: number, maxZ: number,
    out: Set<number>,
  ): Set<number> {
    for (const k of this.keysFor(minX, minY, minZ, maxX, maxY, maxZ)) {
      const set = this.cells.get(k);
      if (!set) continue;
      for (const id of set) out.add(id);
    }
    return out;
  }

  get size(): number {
    return this.owned.size;
  }
}
