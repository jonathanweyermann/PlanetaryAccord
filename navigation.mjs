const BUCKET_SIZE = 8;
const TILE_SIZE = 1.5;
const MAX_EXPANSIONS = 7500;
const MAX_TRAFFIC_EXPANSIONS = 128;
const EPSILON = 1e-7;

const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const distance = (a, b) => Math.sqrt(distanceSquared(a, b));

function pointSegmentDistanceSquared(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared)) : 0;
  return (point.x - a.x - dx * t) ** 2 + (point.z - a.z - dz * t) ** 2;
}

export function pointSegmentDistance(point, a, b) {
  return Math.sqrt(pointSegmentDistanceSquared(point, a, b));
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

export function segmentGap(a, b, c, d) {
  return Math.sqrt(segmentGapSquared(a, b, c, d));
}

function segmentGapSquared(a, b, c, d) {
  if (c === d) return pointSegmentDistanceSquared(c, a, b);
  if (a === b) return pointSegmentDistanceSquared(a, c, d);
  if (Math.max(a.x, b.x) >= Math.min(c.x, d.x) && Math.max(c.x, d.x) >= Math.min(a.x, b.x)
    && Math.max(a.z, b.z) >= Math.min(c.z, d.z) && Math.max(c.z, d.z) >= Math.min(a.z, b.z)
    && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return 0;
  return Math.min(pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
    pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b));
}

class MinHeap {
  items = [];

  push(item) {
    let index = this.items.length;
    while (index) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].priority <= item.priority) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop() {
    const first = this.items[0];
    const tail = this.items.pop();
    if (!this.items.length) return first;
    let index = 0;
    while (2 * index + 1 < this.items.length) {
      let child = 2 * index + 1;
      if (child + 1 < this.items.length && this.items[child + 1].priority < this.items[child].priority) child++;
      if (this.items[child].priority >= tail.priority) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = tail;
    return first;
  }
}

export class Navigation {
  constructor(bounds, ridges) {
    this.bounds = bounds;
    this.columns = Math.ceil((bounds.maxX - bounds.minX) / TILE_SIZE);
    this.rows = Math.ceil((bounds.maxZ - bounds.minZ) / TILE_SIZE);
    this.buckets = new Map();
    this.structureKeys = new Map();
    this.wallOpenings = new Map();
    this.revision = 0;
    for (const ridge of ridges) this.insert(ridge);
  }

  inBounds({ x, z }) {
    const { minX, maxX, minZ, maxZ } = this.bounds;
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  }

  *bucketKeys(a, b, padding) {
    const x0 = Math.floor((Math.min(a.x, b.x) - padding) / BUCKET_SIZE);
    const x1 = Math.floor((Math.max(a.x, b.x) + padding) / BUCKET_SIZE);
    const z0 = Math.floor((Math.min(a.z, b.z) - padding) / BUCKET_SIZE);
    const z1 = Math.floor((Math.max(a.z, b.z) + padding) / BUCKET_SIZE);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) yield `${x},${z}`;
    }
  }

  insert(shape) {
    for (const key of this.bucketKeys(shape.a, shape.b, shape.radius)) {
      if (!this.buckets.has(key)) this.buckets.set(key, new Set());
      this.buckets.get(key).add(shape);
    }
  }

  addStructure(entity, shape) {
    this.structureKeys.set(entity, shape);
    this.insert(shape);
    this.revision++;
  }

  removeStructure(entity) {
    const shape = this.structureKeys.get(entity);
    if (!shape) return;
    for (const key of this.bucketKeys(shape.a, shape.b, shape.radius)) {
      const bucket = this.buckets.get(key);
      bucket.delete(shape);
      if (!bucket.size) this.buckets.delete(key);
    }
    this.structureKeys.delete(entity);
    if (shape.kind === 'wall') this.wallOpenings.set(`${entity.x},${entity.z}`, shape);
    this.revision++;
  }

  intersects(a, b, padding = 0, filter = () => true) {
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.z, b.z);
    const bottom = Math.max(a.z, b.z);
    for (const key of this.bucketKeys(a, b, padding)) {
      for (const shape of this.buckets.get(key) ?? []) {
        const reach = shape.radius + padding - EPSILON;
        if (reach <= 0 || (shape.a.x < left - reach && shape.b.x < left - reach)
          || (shape.a.x > right + reach && shape.b.x > right + reach)
          || (shape.a.z < top - reach && shape.b.z < top - reach)
          || (shape.a.z > bottom + reach && shape.b.z > bottom + reach)) continue;
        if (filter(shape) && segmentGapSquared(a, b, shape.a, shape.b) < reach ** 2) return true;
      }
    }
    return false;
  }

  clearLine(a, b, padding, allowed) {
    if (!this.inBounds(b) || this.intersects(a, b, padding)) return false;
    if (!allowed) return true;
    const steps = Math.max(1, Math.ceil(distance(a, b) / 0.55));
    for (let index = 1; index <= steps; index++) {
      const t = index / steps;
      if (!allowed({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false;
    }
    return true;
  }

  clearShot(from, target) {
    return !this.intersects(from, target, 0, (shape) => shape.entity !== target && (shape.kind === 'wall' || shape.kind === 'ridge'));
  }

  route(start, target, padding, range, allowed, canReach, clearTraffic) {
    const traversable = (a, b) => (!clearTraffic || clearTraffic(a, b)) && this.clearLine(a, b, padding, allowed);
    const { minX, minZ } = this.bounds;
    const pointAt = (column, row) => ({ x: minX + (column + 0.5) * TILE_SIZE, z: minZ + (row + 0.5) * TILE_SIZE });
    const direct = (from, gap) => {
      if (!gap || (gap <= range && (!canReach || canReach(from)))) return from;
      const stop = Math.min(gap, range * 0.96);
      const point = { x: target.x + (from.x - target.x) * stop / gap, z: target.z + (from.z - target.z) * stop / gap };
      return (!canReach || canReach(point)) && traversable(from, point) ? point : null;
    };
    const exact = direct(start, distance(start, target));
    if (exact) return { points: [exact], reaches: true };

    const open = new MinHeap();
    const visited = new Map();
    const gridSize = this.columns * this.rows;
    const access = [];
    const accessByTile = new Map();
    for (const { a, b, radius } of this.wallOpenings.values()) {
      const span = distance(a, b);
      const offset = (padding + radius + 0.35) / span;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      for (const side of [-1, 0, 1]) {
        const point = { x: mid.x + (b.z - a.z) * offset * side, z: mid.z - (b.x - a.x) * offset * side };
        const id = gridSize + access.length;
        access.push({ id, point });
        const column = Math.floor((point.x - minX) / TILE_SIZE);
        const row = Math.floor((point.z - minZ) / TILE_SIZE);
        for (let dz = -2; dz <= 2; dz++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (column + dx < 0 || row + dz < 0 || column + dx >= this.columns || row + dz >= this.rows) continue;
            const tile = (row + dz) * this.columns + column + dx;
            if (!accessByTile.has(tile)) accessByTile.set(tile, []);
            accessByTile.get(tile).push({ id, point });
          }
        }
      }
    }
    const startColumn = Math.floor((start.x - minX) / TILE_SIZE);
    const startRow = Math.floor((start.z - minZ) / TILE_SIZE);
    function add(id, point, cost, gap, parent) {
      const node = { id, point, cost, gap, parent, priority: cost + Math.max(0, gap - range) * 1.3 };
      visited.set(id, node);
      open.push(node);
    }
    function connect(parent, id, point) {
      const from = parent?.point ?? start;
      const cost = (parent?.cost ?? 0) + distance(from, point);
      if (cost < (visited.get(id)?.cost ?? Infinity) && traversable(from, point)) {
        add(id, point, cost, distance(point, target), parent);
      }
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const col = startColumn + dx;
        const row = startRow + dz;
        if (col < 0 || row < 0 || col >= this.columns || row >= this.rows) continue;
        const candidate = pointAt(col, row);
        connect(null, row * this.columns + col, candidate);
      }
    }
    for (const { id, point } of accessByTile.get(startRow * this.columns + startColumn) ?? []) connect(null, id, point);
    let best;
    let end;
    let steps = 0;
    // Traffic is a local, moving obstacle. Keep the full search for permanent terrain.
    const limit = clearTraffic ? MAX_TRAFFIC_EXPANSIONS : MAX_EXPANSIONS;
    while (open.items.length && steps++ < limit) {
      const node = open.pop();
      if (visited.get(node.id) !== node) continue;
      if (!best || node.gap < best.gap) best = node;
      if (node.gap < range + TILE_SIZE * 4) {
        end = direct(node.point, node.gap);
        if (end) { best = node; break; }
      }
      const gridNode = node.id < gridSize;
      const column = gridNode ? node.id % this.columns : Math.floor((node.point.x - minX) / TILE_SIZE);
      const row = gridNode ? Math.floor(node.id / this.columns) : Math.floor((node.point.z - minZ) / TILE_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const col = column + dx;
          const nextRow = row + dz;
          if ((gridNode && !(dx || dz)) || col < 0 || nextRow < 0 || col >= this.columns || nextRow >= this.rows) continue;
          const id = nextRow * this.columns + col;
          connect(node, id, pointAt(col, nextRow));
        }
      }
      for (const { id, point } of accessByTile.get(row * this.columns + column) ?? []) connect(node, id, point);
    }
    if (!best || !end && best.gap >= distance(start, target) - 0.1) return { points: [], reaches: false };
    const path = end ? [end] : [];
    for (let node = best; node; node = node.parent) path.push(node.point);
    path.reverse();
    const points = [];
    let from = start;
    for (let index = 0; index < path.length;) {
      let farther = Math.min(path.length - 1, index + 18);
      while (farther > index && !traversable(from, path[farther])) farther--;
      from = path[farther];
      points.push(from);
      index = farther + 1;
    }
    return { points, reaches: Boolean(end) };
  }
}
