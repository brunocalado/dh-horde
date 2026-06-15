# 0.0.4

### Fixed
- **Multiply** now uses the actor's current remaining HP (`hitPoints.max - hitPoints.value`) instead of always using `hitPoints.max`. A damaged horde token is expanded into the correct number of copies rather than the full horde size.
- **Multiply** tokens are now placed perfectly on the grid around the leader, regardless of the scene's grid offset. Previously, cell-to-pixel conversion used `cellIndex × gridSize`, which is only correct when the grid starts at pixel (0, 0). Scenes with a non-zero grid offset caused positions to be snapped to the wrong cell (off by one in unpredictable directions). All cell-to-pixel conversions now use `canvas.grid.getTopLeftPoint()`, which correctly accounts for the offset. The same fix applies to Move All and Close/Far movement.

# 0.0.3

- v14 only

### Fixed
- **Multiply** no longer crashes with `Cannot read properties of undefined (reading 'TOP_LEFT_VERTEX')`. `foundry.CONST.GRID_SNAPPING_MODE` was relocated in Foundry V14.364; the snap helper now falls back through `foundry.grid.BaseGrid.SNAPPING_MODES` and then the raw bitmask value (`1`) so token placement works regardless of build.
