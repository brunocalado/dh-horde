// ─────────────────────────────────────────────────────────────────────────────
// Horde Executor — Token creation (multiply) and movement animation engine
// ─────────────────────────────────────────────────────────────────────────────

const GATHER_SPEED = {
    fast:   { stepByStep: false, animPerCell: 150, maxAnim: 3000, delay: 0 },
    normal: { stepByStep: true,  animPerCell: 200, maxAnim: 0,    delay: 200 },
    slow:   { stepByStep: true,  animPerCell: 300, maxAnim: 0,    delay: 400 }
};

// Move All always uses 'fast' — dh-horde does not expose a gatherSpeed setting.
const MOVE_ALL_SPEED = 'fast';

// Delay between spawning each successive copy during multiply animation (ms).
// Each token starts moving immediately after spawn; they travel concurrently.
const SPAWN_INTERVAL = 150;

// Animation duration per cell for the spawn-crawl (ms).
const SPAWN_ANIM_PER_CELL = 180;
// Maximum total animation time for the spawn-crawl (ms).
const SPAWN_ANIM_MAX = 2000;

// Fixed movement distances, expressed in the scene's own distance units (Close /
// Far). They are converted to cells at call time via unitsToCells() so a scene with
// a non-default grid distance still advances the horde the right amount — on the
// usual 5 ft scene this yields the historical 6 and 12 cells.
const CLOSE_MOVE_UNITS = 30;
const FAR_MOVE_UNITS   = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Horde-specific operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates `count` copies of originToken. Each copy spawns at the origin
 * position and immediately begins animating toward its assigned spiral slot,
 * creating a visual "horde expanding outward" effect. Copies are spawned
 * one at a time with a short SPAWN_INTERVAL stagger so the expansion is
 * clearly visible rather than appearing all at once.
 *
 * Returns the IDs of all created tokens once the last one has finished moving.
 *
 * @param {Token} originToken
 * @param {number} count
 * @param {Set<string>} [excludeIds=new Set()] - Token IDs to ignore during
 *        occupation checks (e.g. existing horde members during regeneration)
 * @returns {Promise<string[]>}
 */
export async function createHordeCopies(originToken, count, excludeIds = new Set()) {
    if (!canvas.ready || count <= 0) return [];

    const scene   = canvas.scene;
    const lattice = createLattice(originToken);

    const baseData = originToken.document.toObject();
    delete baseData._id;

    const { w: lw, h: lh } = getTokenSizeInCells(originToken);
    const leaderStartRing   = Math.ceil(Math.max(lw, lh) / 2);

    const leaderCell  = lattice.toCell(originToken.document.x, originToken.document.y);
    const leaderCellX = leaderCell.x + Math.floor(lw / 2);
    const leaderCellY = leaderCell.y + Math.floor(lh / 2);

    // ── Phase 1: Pre-compute all destination cells ──
    const spiralOffsets      = generateSpiralPositions((count + excludeIds.size) * 3, leaderStartRing);
    const reservedPositions  = new Set();
    const destCells          = [];   // { x, y } in pixel coords, snapped

    const originSnapped = lattice.snap(originToken.document.x, originToken.document.y);
    reservedPositions.add(`${originSnapped.x},${originSnapped.y}`);

    // Reserve cells already occupied by existing horde members so new tokens
    // never stack on top of them, but still allow spiral slots past them.
    for (const id of excludeIds) {
        const tok = canvas.tokens.get(id);
        if (!tok || tok.id === originToken.id) continue;
        const sp = lattice.snap(tok.document.x, tok.document.y);
        reservedPositions.add(`${sp.x},${sp.y}`);
    }

    let spiralIdx = 0;
    while (destCells.length < count && spiralIdx < spiralOffsets.length) {
        const offset  = spiralOffsets[spiralIdx++];
        const cellX   = leaderCellX + offset.x;
        const cellY   = leaderCellY + offset.y;
        const snapped = lattice.toPoint(cellX, cellY);
        const posKey  = `${snapped.x},${snapped.y}`;

        if (reservedPositions.has(posKey)) continue;
        if (isCellOccupied(originToken, snapped.x, snapped.y, excludeIds)) continue;

        reservedPositions.add(posKey);
        destCells.push(snapped);
    }

    if (destCells.length === 0) return [];

    // ── Phase 2: Spawn + animate each copy sequentially with SPAWN_INTERVAL stagger ──
    const createdIds   = [];
    const movePromises = [];

    const originCell = lattice.toCell(originToken.document.x, originToken.document.y);

    for (const dest of destCells) {
        // Create the copy at the origin position
        const [doc] = await scene.createEmbeddedDocuments('Token', [
            { ...baseData, x: originSnapped.x, y: originSnapped.y }
        ]);

        if (!doc) continue;
        createdIds.push(doc.id);

        // Resolve the live Token object so we can call tokenDoc.move()
        const liveToken = canvas.tokens.get(doc.id);

        if (liveToken) {
            const destCell = lattice.toCell(dest.x, dest.y);
            // Fire-and-forget: store the promise so we can await all at the end
            movePromises.push(spawnCrawl(liveToken, originCell, destCell, lattice));
        }

        // Stagger: wait before spawning the next copy
        if (destCells.indexOf(dest) < destCells.length - 1) {
            await new Promise(r => setTimeout(r, SPAWN_INTERVAL));
        }
    }

    // Wait for all crawl animations to finish before returning
    await Promise.all(movePromises);

    return createdIds;
}

/**
 * Animates a freshly spawned token from originCell to destCell using
 * the A* path. Uses a single move() call for a smooth slide.
 *
 * @param {Token}  token
 * @param {{x,y}}  originCell  grid-cell coords
 * @param {{x,y}}  destCell    grid-cell coords
 * @param {object} lattice     cell lattice for this operation (see createLattice)
 */
async function spawnCrawl(token, originCell, destCell, lattice) {
    const tokenDoc = token.document;
    if (!tokenDoc) return;

    const path = findPath(originCell, destCell, lattice);

    if (!path || path.length < 2) {
        // Fallback: direct teleport if no path found
        const sp = lattice.toPoint(destCell.x, destCell.y);
        await tokenDoc.update({ x: sp.x, y: sp.y });
        return;
    }

    const simplified = simplifyPath(path);
    const waypoints  = simplified.slice(1).map(cell => lattice.toPoint(cell.x, cell.y));

    const duration = Math.min(SPAWN_ANIM_PER_CELL * path.length, SPAWN_ANIM_MAX);

    await tokenDoc.move(waypoints, {
        method: 'api',
        showRuler: false,
        constrainOptions: { ignoreWalls: true },
        animation: { duration }
    });
}

/**
 * Distributes memberTokens evenly across targetTokens using round-robin
 * assignment. Members are sorted by their distance to their nearest target
 * before distributing, so each target receives a roughly equal share.
 * @param {Token[]} memberTokens
 * @param {Token[]} targetTokens
 * @returns {Token[][]}
 */
function assignMembersToTargets(memberTokens, targetTokens) {
    const groups = targetTokens.map(() => []);
    const sorted = [...memberTokens].sort((a, b) => {
        const distA = Math.min(...targetTokens.map(t => Math.hypot(a.center.x - t.center.x, a.center.y - t.center.y)));
        const distB = Math.min(...targetTokens.map(t => Math.hypot(b.center.x - t.center.x, b.center.y - t.center.y)));
        return distA - distB;
    });
    sorted.forEach((member, i) => groups[i % targetTokens.length].push(member));
    return groups;
}

/**
 * Moves all horde member tokens toward one or more target tokens.
 *
 * All modes distribute the horde across multiple targets (Kill them All logic):
 * each member is assigned to its nearest target and given a unique spiral slot
 * around that target so the horde surrounds rather than stacks.
 *
 * 'all'         — Walk the full path to the spiral slot (A* + gatherToken).
 * 'close'/'far' — Walk at most maxStep cells along the A* path toward the
 *                 spiral slot, then stop. Repeated presses advance the horde.
 *
 * @param {Token[]} memberTokens  - Horde member tokens to move
 * @param {Token|Token[]} targets - Single target or array of targets
 * @param {'close'|'far'|'all'} mode
 */
export async function moveHordeTowardTarget(memberTokens, targets, mode) {
    if (!canvas.ready || memberTokens.length === 0) return;

    const targetArray = (Array.isArray(targets) ? targets : [targets]).filter(Boolean);
    if (targetArray.length === 0) return;

    // Anchored on the primary target so its surrounding ring is exact. Secondary
    // targets end up under one cell off the lattice, which is cosmetic only —
    // isCellOccupied() is a true bounding-box test, not a cell lookup.
    const lattice = createLattice(targetArray[0]);

    // Distribute members across targets by proximity
    const memberGroups = assignMembersToTargets(memberTokens, targetArray);

    // ── 'all' mode: full walk to spiral slot (mirrors gatherToTargets exactly) ──
    if (mode === 'all') {
        const allMovers    = memberGroups.flat();
        const reservedIds  = new Set(allMovers.map(t => t.id));
        const movePromises = [];

        for (let gi = 0; gi < targetArray.length; gi++) {
            const targetToken = targetArray[gi];
            const members     = memberGroups[gi];
            if (!members || members.length === 0) continue;

            const { w: tw, h: th } = getTokenSizeInCells(targetToken);
            const startRing   = Math.ceil(Math.max(tw, th) / 2);
            const targetCell0 = lattice.toCell(targetToken.document.x, targetToken.document.y);
            const targetCellX = targetCell0.x + Math.floor(tw / 2);
            const targetCellY = targetCell0.y + Math.floor(th / 2);
            const spiralPositions = generateSpiralPositions(members.length, startRing);

            for (let i = 0; i < members.length; i++) {
                const memberToken = members[i];
                reservedIds.delete(memberToken.id);
                const targetCell = {
                    x: targetCellX + spiralPositions[i].x,
                    y: targetCellY + spiralPositions[i].y
                };
                movePromises.push(gatherToken(memberToken, targetCell, lattice, new Set(reservedIds), 48, MOVE_ALL_SPEED));
            }
        }

        await Promise.all(movePromises);
        return;
    }

    // ── 'close' / 'far' modes: step toward spiral slot, stop after maxStep cells ──
    const maxStep = unitsToCells((mode === 'far') ? FAR_MOVE_UNITS : CLOSE_MOVE_UNITS);

    const hordeIds      = new Set(memberTokens.map(t => t.id));
    const reservedCells = new Set();

    for (const t of memberTokens) {
        const snapped = lattice.snap(t.document.x, t.document.y);
        reservedCells.add(`${snapped.x},${snapped.y}`);
    }

    const assignments = [];

    for (let gi = 0; gi < targetArray.length; gi++) {
        const targetToken = targetArray[gi];
        const members     = memberGroups[gi];
        if (!members || members.length === 0) continue;

        const { w: tw, h: th } = getTokenSizeInCells(targetToken);
        const startRing   = Math.ceil(Math.max(tw, th) / 2);
        const targetCell0 = lattice.toCell(targetToken.document.x, targetToken.document.y);
        const targetCellX = targetCell0.x + Math.floor(tw / 2);
        const targetCellY = targetCell0.y + Math.floor(th / 2);

        const spiralPositions = generateSpiralPositions(members.length * 4, startRing);
        const usedSlotIndices = new Set();

        for (const memberToken of members) {
            const tokenDoc  = memberToken.document;
            const startCell = lattice.toCell(tokenDoc.x, tokenDoc.y);

            let bestDestCell = null;
            let bestSlotIdx  = -1;

            for (let si = 0; si < spiralPositions.length; si++) {
                if (usedSlotIndices.has(si)) continue;

                const slotCell = {
                    x: targetCellX + spiralPositions[si].x,
                    y: targetCellY + spiralPositions[si].y
                };

                const path = findPath(startCell, slotCell, lattice);
                if (!path || path.length < 2) continue;

                const stepIdx  = Math.min(path.length - 1, maxStep);
                const stopCell = path[stepIdx];

                const candidateOffsets = generateSpiralPositions(32, 0);
                let foundCell = null;

                for (const offset of candidateOffsets) {
                    const cellX   = stopCell.x + offset.x;
                    const cellY   = stopCell.y + offset.y;
                    const snapped = lattice.toPoint(cellX, cellY);
                    const posKey  = `${snapped.x},${snapped.y}`;

                    if (reservedCells.has(posKey)) continue;
                    if (isCellOccupied(memberToken, snapped.x, snapped.y, hordeIds)) continue;

                    foundCell = { x: cellX, y: cellY };
                    break;
                }

                if (!foundCell) continue;

                bestDestCell = foundCell;
                bestSlotIdx  = si;
                break;
            }

            if (bestDestCell === null) {
                console.warn(`dh-horde | (moveHordeTowardTarget) [${memberToken.name}]: no free destination found.`);
                continue;
            }

            usedSlotIndices.add(bestSlotIdx);
            const snapped = lattice.toPoint(bestDestCell.x, bestDestCell.y);
            reservedCells.add(`${snapped.x},${snapped.y}`);
            assignments.push({ memberToken, destCell: bestDestCell });
        }
    }

    const updates = [];
    for (const { memberToken, destCell } of assignments) {
        const sp = lattice.toPoint(destCell.x, destCell.y);
        if (sp.x === memberToken.document.x && sp.y === memberToken.document.y) continue;
        updates.push({ _id: memberToken.id, x: sp.x, y: sp.y });
    }

    if (updates.length > 0) {
        await canvas.scene.updateEmbeddedDocuments('Token', updates);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Movement utilities
// ─────────────────────────────────────────────────────────────────────────────

async function gatherToken(memberToken, targetCellPos, lattice, reservedIds = new Set(), maxSearch = 48, speed = 'fast') {
    const tokenDoc = memberToken.document;
    if (!tokenDoc) return;

    const preset = GATHER_SPEED[speed] ?? GATHER_SPEED.fast;

    const startCell = lattice.toCell(tokenDoc.x, tokenDoc.y);

    const candidates = generateSpiralPositions(maxSearch, 0);

    for (const offset of candidates) {
        const goalCell = {
            x: targetCellPos.x + offset.x,
            y: targetCellPos.y + offset.y
        };

        const snapped = lattice.toPoint(goalCell.x, goalCell.y);

        if (isCellOccupied(memberToken, snapped.x, snapped.y, reservedIds)) continue;

        const path = findPath(startCell, goalCell, lattice);
        if (!path || path.length < 2) continue;

        if (preset.stepByStep) {
            for (let i = 1; i < path.length; i++) {
                const cell = path[i];
                const sp   = lattice.toPoint(cell.x, cell.y);
                await tokenDoc.move(
                    [{ x: sp.x, y: sp.y }],
                    { method: 'api', showRuler: false, constrainOptions: { ignoreWalls: true }, animation: { duration: preset.animPerCell } }
                );
                if (preset.delay > 0 && i < path.length - 1) {
                    await new Promise(r => setTimeout(r, preset.delay));
                }
            }
        } else {
            const simplified = simplifyPath(path);
            const waypoints  = simplified.slice(1).map(cell => lattice.toPoint(cell.x, cell.y));
            await tokenDoc.move(waypoints, {
                method: 'api',
                showRuler: false,
                constrainOptions: { ignoreWalls: true },
                animation: { duration: Math.min(preset.animPerCell * path.length, preset.maxAnim) }
            });
        }
        return;
    }

    console.warn(`dh-horde | (gatherToken) [${memberToken.name}]: no reachable free cell found within ${maxSearch} attempts, leaving in place.`);
}

function findPath(startCell, goalCell, lattice, maxIterations = 800) {
    const gs  = lattice.size;
    const key = (x, y) => `${x},${y}`;

    const dirs = [
        { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
        { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }
    ];

    const heuristic = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

    const startKey = key(startCell.x, startCell.y);
    const goalKey  = key(goalCell.x,  goalCell.y);

    const openSet = new Map();
    openSet.set(startKey, { x: startCell.x, y: startCell.y, g: 0, f: heuristic(startCell, goalCell) });

    const closedSet = new Set();
    const cameFrom  = new Map();
    let   iterations = 0;

    while (openSet.size > 0 && iterations < maxIterations) {
        iterations++;

        let current = null, currentKey = null;
        for (const [k, node] of openSet) {
            if (!current || node.f < current.f) { current = node; currentKey = k; }
        }

        if (currentKey === goalKey) {
            const path = [];
            let ck = currentKey;
            while (ck) {
                const [cx, cy] = ck.split(',').map(Number);
                path.unshift({ x: cx, y: cy });
                ck = cameFrom.get(ck);
            }
            return path;
        }

        openSet.delete(currentKey);
        closedSet.add(currentKey);

        for (const dir of dirs) {
            const nx = current.x + dir.x;
            const ny = current.y + dir.y;
            const nk = key(nx, ny);

            if (closedSet.has(nk)) continue;

            const fromPt     = lattice.toPoint(current.x, current.y);
            const toPt       = lattice.toPoint(nx, ny);
            const fromCenter = { x: fromPt.x + gs / 2, y: fromPt.y + gs / 2 };
            const toCenter   = { x: toPt.x  + gs / 2, y: toPt.y  + gs / 2 };
            const wallHit    = CONFIG.Canvas.polygonBackends.move.testCollision(
                fromCenter, toCenter, { type: 'move', mode: 'any' }
            );
            if (wallHit) continue;

            const moveCost   = (dir.x !== 0 && dir.y !== 0) ? 1.414 : 1;
            const tentativeG = current.g + moveCost;
            const existing   = openSet.get(nk);
            if (existing && tentativeG >= existing.g) continue;

            cameFrom.set(nk, currentKey);
            openSet.set(nk, { x: nx, y: ny, g: tentativeG, f: tentativeG + heuristic({ x: nx, y: ny }, goalCell) });
        }
    }

    return null;
}

function simplifyPath(path) {
    if (path.length <= 2) return path;
    const simplified = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
        const prev = path[i - 1], curr = path[i], next = path[i + 1];
        if ((curr.x - prev.x) !== (next.x - curr.x) || (curr.y - prev.y) !== (next.y - curr.y)) {
            simplified.push(curr);
        }
    }
    simplified.push(path[path.length - 1]);
    return simplified;
}

/**
 * Builds the cell lattice that all placement math runs on, for the duration of a
 * single horde operation. Created once per entry point and passed down rather than
 * kept in module state, because operations await animations and can overlap.
 *
 * On a square scene the lattice IS the scene grid: SquareGrid#getTopLeftPoint({i, j})
 * returns {x: j * size, y: i * size} with no scene offset, so the core API is used
 * directly and behaviour is unchanged.
 *
 * On a GRIDLESS scene the core grid API cannot be used at all: GridlessGrid treats
 * offsets as raw pixels — getTopLeftPoint({i, j}) returns {x: j, y: i} — and
 * getSnappedPoint is the identity function. Cell coordinates would therefore collapse
 * into the top-left corner of the scene. The lattice is computed here instead, one
 * grid.size square per cell, aligned to the token the horde forms around so its rings
 * sit flush against that token rather than against the scene origin.
 *
 * @param {Token} anchorToken - Token the operation revolves around (leader or target)
 * @returns {{size: number, toPoint: Function, toCell: Function, snap: Function}}
 */
function createLattice(anchorToken) {
    const size     = canvas.grid.size;
    const gridless = canvas.grid.isGridless;

    // Pixel offset of cell (0,0). Zero on a real grid; on gridless the anchor token's
    // position modulo one cell, so the anchor lands exactly on a cell boundary while
    // cell indices stay small. Double modulo keeps a negative coordinate positive.
    // TokenDocument x/y and Scene grid.size are integer fields, so every lattice point
    // is an integer too — TokenDocument would reject a fractional coordinate.
    const ox = gridless ? (((anchorToken.document.x % size) + size) % size) : 0;
    const oy = gridless ? (((anchorToken.document.y % size) + size) % size) : 0;

    return {
        size,

        /** Cell {j=column, i=row} → top-left pixel coordinates. */
        toPoint(j, i) {
            if (gridless) return { x: ox + (j * size), y: oy + (i * size) };
            return canvas.grid.getTopLeftPoint({ i, j });
        },

        /** Pixel coordinates → cell {x=column, y=row}. */
        toCell(x, y) {
            return {
                x: Math.floor((x - ox) / size),
                y: Math.floor((y - oy) / size)
            };
        },

        /** Pixel coordinates → top-left pixel coordinates of the containing cell. */
        snap(x, y) {
            if (gridless) {
                const cell = this.toCell(x, y);
                return this.toPoint(cell.x, cell.y);
            }
            // GRID_SNAPPING_MODE was relocated in some V14 builds; fall back to the raw bitmask (1 = TOP_LEFT_VERTEX).
            const snapModes = foundry.CONST.GRID_SNAPPING_MODE ?? foundry.grid?.BaseGrid?.SNAPPING_MODES;
            const mode = snapModes?.TOP_LEFT_VERTEX ?? 1;
            return canvas.grid.getSnappedPoint({ x, y }, { mode });
        }
    };
}

/**
 * Converts a distance in the scene's own units into whole lattice cells.
 * @param {number} units
 * @returns {number}
 */
function unitsToCells(units) {
    return Math.max(1, Math.round(units / (canvas.grid.distance || 5)));
}

function generateSpiralPositions(count, startRing = 1) {
    const positions = [];
    let ring = startRing;
    while (positions.length < count) {
        const r        = ring;
        const perimeter = [];
        for (let x = -r; x <= r; x++)          perimeter.push({ x, y: -r });
        for (let y = -r + 1; y <= r; y++)      perimeter.push({ x: r, y });
        for (let x = r - 1; x >= -r; x--)     perimeter.push({ x, y: r });
        for (let y = r - 1; y >= -r + 1; y--) perimeter.push({ x: -r, y });
        for (const p of perimeter) {
            positions.push(p);
            if (positions.length >= count) break;
        }
        ring++;
    }
    return positions;
}

function getTokenSizeInCells(token) {
    const w = token.document?.width  ?? 1;
    const h = token.document?.height ?? 1;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}

// Bounding-box overlap test in raw pixels, so it holds on gridless scenes where
// token positions do not line up with any cell boundary.
function isCellOccupied(movingToken, px, py, excludeIds = new Set()) {
    const gs = canvas.grid.size;
    const { w: mw, h: mh } = getTokenSizeInCells(movingToken);
    const mx2 = px + (mw * gs), my2 = py + (mh * gs);

    for (const other of canvas.tokens.placeables) {
        if (other.id === movingToken.id)  continue;
        if (excludeIds.has(other.id))     continue;
        if (other.document.hidden)        continue;

        const ox1 = other.document.x;
        const oy1 = other.document.y;
        const { w: ow, h: oh } = getTokenSizeInCells(other);
        const ox2 = ox1 + (ow * gs), oy2 = oy1 + (oh * gs);

        if (px < ox2 && mx2 > ox1 && py < oy2 && my2 > oy1) return true;
    }
    return false;
}
