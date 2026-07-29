# 0.0.5

- https://github.com/brunocalado/dh-horde/issues/2

### Added
- **Gridless scenes are now supported.** Multiply, Move Close, Move Far and Move All all work on scenes whose Grid Type is set to *Gridless*. Foundry's `GridlessGrid` treats a grid offset as a raw pixel coordinate — `getTopLeftPoint({i, j})` returns `{x: j, y: i}` — and its `getSnappedPoint()` is a no-op, so the module's cell math used to collapse the whole horde into the top-left corner of the map. Placement now runs on an internal lattice of one `grid.size` square per cell, aligned to the leader (or target) token so the horde forms flush around it. Square grid behaviour is unchanged. Hexagonal grids are still not supported.

### Changed
- **Move Close** and **Move Far** distances are now derived from the scene's own distance units (30 and 60) instead of a hardcoded 6 and 12 cells. Scenes using the standard 5 ft grid behave exactly as before; scenes configured with a different grid scale now advance the horde by the intended distance.

# 0.0.4

### Fixed
- **Multiply** now uses the actor's current remaining HP (`hitPoints.max - hitPoints.value`) instead of always using `hitPoints.max`. A damaged horde token is expanded into the correct number of copies rather than the full horde size.
- **Multiply** tokens are now placed perfectly on the grid around the leader, regardless of the scene's grid offset. Previously, cell-to-pixel conversion used `cellIndex × gridSize`, which is only correct when the grid starts at pixel (0, 0). Scenes with a non-zero grid offset caused positions to be snapped to the wrong cell (off by one in unpredictable directions). All cell-to-pixel conversions now use `canvas.grid.getTopLeftPoint()`, which correctly accounts for the offset. The same fix applies to Move All and Close/Far movement.

# 0.0.3

- v14 only

### Fixed
- **Multiply** no longer crashes with `Cannot read properties of undefined (reading 'TOP_LEFT_VERTEX')`. `foundry.CONST.GRID_SNAPPING_MODE` was relocated in Foundry V14.364; the snap helper now falls back through `foundry.grid.BaseGrid.SNAPPING_MODES` and then the raw bitmask value (`1`) so token placement works regardless of build.
