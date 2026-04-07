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

// Fixed movement distances (grid squares). 6 = 30 ft Close, 12 = 60 ft Far.
const CLOSE_MOVE_DISTANCE = 6;
const FAR_MOVE_DISTANCE   = 12;

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

    const scene = canvas.scene;
    const gs    = canvas.grid.size;

    const baseData = originToken.document.toObject();
    delete baseData._id;

    const { w: lw, h: lh } = getTokenSizeInCells(originToken);
    const leaderStartRing   = Math.ceil(Math.max(lw, lh) / 2);

    const leaderCellX = Math.floor(originToken.document.x / gs) + Math.floor(lw / 2);
    const leaderCellY = Math.floor(originToken.document.y / gs) + Math.floor(lh / 2);

    // ── Phase 1: Pre-compute all destination cells ──
    const spiralOffsets      = generateSpiralPositions((count + excludeIds.size) * 3, leaderStartRing);
    const reservedPositions  = new Set();
    const destCells          = [];   // { x, y } in pixel coords, snapped

    const originSnapped = snapPoint(originToken.document.x, originToken.document.y);
    reservedPositions.add(`${originSnapped.x},${originSnapped.y}`);

    // Reserve cells already occupied by existing horde members so new tokens
    // never stack on top of them, but still allow spiral slots past them.
    for (const id of excludeIds) {
        const tok = canvas.tokens.get(id);
        if (!tok || tok.id === originToken.id) continue;
        const sp = snapPoint(tok.document.x, tok.document.y);
        reservedPositions.add(`${sp.x},${sp.y}`);
    }

    let spiralIdx = 0;
    while (destCells.length < count && spiralIdx < spiralOffsets.length) {
        const offset  = spiralOffsets[spiralIdx++];
        const cellX   = leaderCellX + offset.x;
        const cellY   = leaderCellY + offset.y;
        const snapped = snapPoint(cellX * gs, cellY * gs);
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

    const originCell = {
        x: Math.floor(originToken.document.x / gs),
        y: Math.floor(originToken.document.y / gs)
    };

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
            const destCell = {
                x: Math.floor(dest.x / gs),
                y: Math.floor(dest.y / gs)
            };
            // Fire-and-forget: store the promise so we can await all at the end
            movePromises.push(spawnCrawl(liveToken, originCell, destCell));
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
 */
async function spawnCrawl(token, originCell, destCell) {
    const tokenDoc = token.document;
    if (!tokenDoc) return;

    const gs   = canvas.grid.size;
    const path = findPath(originCell, destCell);

    if (!path || path.length < 2) {
        // Fallback: direct teleport if no path found
        const sp = snapPoint(destCell.x * gs, destCell.y * gs);
        await tokenDoc.update({ x: sp.x, y: sp.y });
        return;
    }

    const simplified = simplifyPath(path);
    const waypoints  = simplified.slice(1).map(cell => {
        const sp = snapPoint(cell.x * gs, cell.y * gs);
        return { x: sp.x, y: sp.y };
    });

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

    const gs          = canvas.grid.size;
    const targetArray = Array.isArray(targets) ? targets : [targets];

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
            const targetCellX = Math.floor(targetToken.document.x / gs) + Math.floor(tw / 2);
            const targetCellY = Math.floor(targetToken.document.y / gs) + Math.floor(th / 2);
            const spiralPositions = generateSpiralPositions(members.length, startRing);

            for (let i = 0; i < members.length; i++) {
                const memberToken = members[i];
                reservedIds.delete(memberToken.id);
                const targetCell = {
                    x: targetCellX + spiralPositions[i].x,
                    y: targetCellY + spiralPositions[i].y
                };
                movePromises.push(gatherToken(memberToken, targetCell, new Set(reservedIds), 48, MOVE_ALL_SPEED));
            }
        }

        await Promise.all(movePromises);
        return;
    }

    // ── 'close' / 'far' modes: step toward spiral slot, stop after maxStep cells ──
    const maxStep = (mode === 'far') ? FAR_MOVE_DISTANCE : CLOSE_MOVE_DISTANCE;

    const hordeIds      = new Set(memberTokens.map(t => t.id));
    const reservedCells = new Set();

    for (const t of memberTokens) {
        const snapped = snapPoint(t.document.x, t.document.y);
        reservedCells.add(`${snapped.x},${snapped.y}`);
    }

    const assignments = [];

    for (let gi = 0; gi < targetArray.length; gi++) {
        const targetToken = targetArray[gi];
        const members     = memberGroups[gi];
        if (!members || members.length === 0) continue;

        const { w: tw, h: th } = getTokenSizeInCells(targetToken);
        const startRing   = Math.ceil(Math.max(tw, th) / 2);
        const targetCellX = Math.floor(targetToken.document.x / gs) + Math.floor(tw / 2);
        const targetCellY = Math.floor(targetToken.document.y / gs) + Math.floor(th / 2);

        const spiralPositions = generateSpiralPositions(members.length * 4, startRing);
        const usedSlotIndices = new Set();

        for (const memberToken of members) {
            const tokenDoc  = memberToken.document;
            const startCell = {
                x: Math.floor(tokenDoc.x / gs),
                y: Math.floor(tokenDoc.y / gs)
            };

            let bestDestCell = null;
            let bestSlotIdx  = -1;

            for (let si = 0; si < spiralPositions.length; si++) {
                if (usedSlotIndices.has(si)) continue;

                const slotCell = {
                    x: targetCellX + spiralPositions[si].x,
                    y: targetCellY + spiralPositions[si].y
                };

                const path = findPath(startCell, slotCell);
                if (!path || path.length < 2) continue;

                const stepIdx  = Math.min(path.length - 1, maxStep);
                const stopCell = path[stepIdx];

                const candidateOffsets = generateSpiralPositions(32, 0);
                let foundCell = null;

                for (const offset of candidateOffsets) {
                    const cellX   = stopCell.x + offset.x;
                    const cellY   = stopCell.y + offset.y;
                    const snapped = snapPoint(cellX * gs, cellY * gs);
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
            const snapped = snapPoint(bestDestCell.x * gs, bestDestCell.y * gs);
            reservedCells.add(`${snapped.x},${snapped.y}`);
            assignments.push({ memberToken, destCell: bestDestCell });
        }
    }

    const updates = [];
    for (const { memberToken, destCell } of assignments) {
        const sp = snapPoint(destCell.x * gs, destCell.y * gs);
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

async function gatherToken(memberToken, targetCellPos, reservedIds = new Set(), maxSearch = 48, speed = 'fast') {
    const tokenDoc = memberToken.document;
    if (!tokenDoc) return;

    const gs     = canvas.grid.size;
    const preset = GATHER_SPEED[speed] ?? GATHER_SPEED.fast;

    const startCell = {
        x: Math.floor(tokenDoc.x / gs),
        y: Math.floor(tokenDoc.y / gs)
    };

    const candidates = generateSpiralPositions(maxSearch, 0);

    for (const offset of candidates) {
        const goalCell = {
            x: targetCellPos.x + offset.x,
            y: targetCellPos.y + offset.y
        };

        const snapped = snapPoint(goalCell.x * gs, goalCell.y * gs);

        if (isCellOccupied(memberToken, snapped.x, snapped.y, reservedIds)) continue;

        const path = findPath(startCell, goalCell);
        if (!path || path.length < 2) continue;

        if (preset.stepByStep) {
            for (let i = 1; i < path.length; i++) {
                const cell = path[i];
                const sp   = snapPoint(cell.x * gs, cell.y * gs);
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
            const waypoints  = simplified.slice(1).map(cell => {
                const sp = snapPoint(cell.x * gs, cell.y * gs);
                return { x: sp.x, y: sp.y };
            });
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

function findPath(startCell, goalCell, maxIterations = 800) {
    const gs  = canvas.grid.size;
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

            const fromCenter = { x: current.x * gs + gs / 2, y: current.y * gs + gs / 2 };
            const toCenter   = { x: nx * gs + gs / 2,        y: ny * gs + gs / 2 };
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

function snapPoint(x, y) {
    const mode = CONST.GRID_SNAPPING_MODE?.TOP_LEFT_VERTEX ?? 0x10;
    return canvas.grid.getSnappedPoint({ x, y }, { mode });
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

function isCellOccupied(movingToken, px, py, excludeIds = new Set()) {
    const gs = canvas.grid.size;
    const { w: mw, h: mh } = getTokenSizeInCells(movingToken);
    const mx1 = px / gs,      my1 = py / gs;
    const mx2 = mx1 + mw,    my2 = my1 + mh;

    for (const other of canvas.tokens.placeables) {
        if (other.id === movingToken.id)  continue;
        if (excludeIds.has(other.id))     continue;
        if (other.document.hidden)        continue;

        const ox1 = other.document.x / gs;
        const oy1 = other.document.y / gs;
        const { w: ow, h: oh } = getTokenSizeInCells(other);
        const ox2 = ox1 + ow, oy2 = oy1 + oh;

        if (mx1 < ox2 && mx2 > ox1 && my1 < oy2 && my2 > oy1) return true;
    }
    return false;
}
