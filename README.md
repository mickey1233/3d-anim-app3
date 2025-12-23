# 3D Animation App (Pure 3D Workflow)

This project is a React-based 3D application for animating CAD parts using a geometry-based workflow. It has been refactored to remove image-based AI features and rely solely on 3D interaction.

## Features

### New Functionality (3D Animation)
- **Face-to-Face picking**: Select Start/End points by clicking on 3D object faces (Triangle Centroid).
- **Animation Studio**:
  - Select "Moving Object".
  - visual Start/End markers (Draggable).
  - Configurable Duration and Easing.
  - "Run Animation" to interpolate position.
- **Scene Graph**: View and select objects from a list.

### Retained Features (Non-negotiable)
- **3D Selection**: Click objects in canvas or list.
- **Property Editor**: Modify Translate/Rotate/Scale (Real-time).
- **Bounding Box**: Visual feedback on selection.
- **Labels**: Object names displayed in 3D.
- **CAD Import**: Supports `.glb`, `.gltf`.

## Setup & Run

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Run Dev Server**:
   ```bash
   npm run dev
   ```
   Access at `http://localhost:5173`.

## Testing

### Manual Acceptance Test
1. **Load Demo**: Click "Load Demo (Spark.glb)" in the sidebar.
2. **Select Object**: Choose "Part1 (Lid)" from the "Target Object" dropdown in Animation Studio.
3. **Pick Start**: 
   - Click "Pick Start" button (Icon).
   - Click on the Lid's top face in the 3D scene.
   - Verify a **Green Marker** appears.
4. **Pick End**:
   - Click "Pick End" button.
   - Click on the Base's top face.
   - Verify a **Blue Marker** appears.
5. **Adjust**: Drag the markers to fine-tune positions.
6. **Run**: Click "RUN" and watch the Lid move to the Base.

### Automated Smoke Test (Playwright)
A Playwright test file is provided in `tests/smoke.spec.ts`.

To run (requires Playwright setup):
```bash
npx playwright test
```

## Project Structure
- `src/components/Three`: 3D Logic (`Scene.tsx`, `Model.tsx`).
- `src/components/UI`: UI Panels (`AnimationStudio.tsx`, `Sidebar.tsx`).
- `src/store`: Global State (`useAppStore.ts`).
- `public/demo`: Sample CAD files.
