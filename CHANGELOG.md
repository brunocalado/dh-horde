# 0.0.3

- v14 only

### Fixed
- **Multiply** no longer crashes with `Cannot read properties of undefined (reading 'TOP_LEFT_VERTEX')`. `foundry.CONST.GRID_SNAPPING_MODE` was relocated in Foundry V14.364; the snap helper now falls back through `foundry.grid.BaseGrid.SNAPPING_MODES` and then the raw bitmask value (`1`) so token placement works regardless of build.
