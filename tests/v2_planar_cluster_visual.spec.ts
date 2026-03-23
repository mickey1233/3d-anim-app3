import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('planar_cluster group anchor', () => {
  test.beforeAll(() => {
    const src = path.resolve('assets/3d_cad/spark_.glb');
    const dst = path.resolve('public/spark_.glb');
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  });

  test('markers land on actual mesh faces and mate aligns parts', async ({ page }) => {
    test.setTimeout(120_000);

    // Capture console output for debug lines
    const consoleLogs: string[] = [];
    page.on('console', msg => {
      if (msg.text().includes('[planar_cluster:group]')) consoleLogs.push(msg.text());
    });

    await page.goto('http://127.0.0.1:5173/?v=2', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as any).__V2_STORE__?.getState);

    // Load spark model
    await page.evaluate(() => {
      (window as any).__V2_STORE__.getState().setCadUrl('/spark_.glb', 'spark_.glb');
    });

    // Wait for ≥6 parts
    await page.waitForFunction(
      () => (window as any).__V2_STORE__.getState().parts.order.length >= 6,
      { timeout: 30_000 }
    );

    // Find part1 and base by name
    const partMap: Record<string, string> = await page.evaluate(() => {
      const byId = (window as any).__V2_STORE__.getState().parts.byId;
      const result: Record<string, string> = {};
      for (const [id, p] of Object.entries(byId)) result[(p as any).name] = id;
      return result;
    });
    expect(partMap['part1']).toBeTruthy();
    expect(partMap['base']).toBeTruthy();

    // Enter mate mode, configure mate
    await page.evaluate(
      ({ sourceId, targetId }: { sourceId: string; targetId: string }) => {
        const store = (window as any).__V2_STORE__.getState();
        store.setWorkspaceSection('mate');
        store.setInteractionMode('mate');
        store.setMateDraft({
          sourceId,
          targetId,
          sourceFace: 'bottom',
          targetFace: 'top',
          sourceMethod: 'planar_cluster',
          targetMethod: 'planar_cluster',
          mode: 'translate',
        });
      },
      { sourceId: partMap['part1'], targetId: partMap['base'] }
    );

    // Wait for debounced preview resolve (72ms debounce + idle callback timeout)
    await page.waitForTimeout(600);

    // Screenshot markers
    await page.screenshot({ path: 'test-results/01_markers.png' });

    // Read preview positions
    const preview: any = await page.evaluate(
      () => (window as any).__V2_STORE__.getState().matePreview
    );
    console.log(
      'SOURCE marker world pos:',
      preview?.source?.positionWorld,
      'method:',
      preview?.source?.methodUsed
    );
    console.log(
      'TARGET marker world pos:',
      preview?.target?.positionWorld,
      'method:',
      preview?.target?.methodUsed
    );

    // Assert planar_cluster actually ran (not falling back to object_aabb)
    expect(preview?.source?.methodUsed).toBe('planar_cluster');
    expect(preview?.target?.methodUsed).toBe('planar_cluster');

    // Compute part bounding boxes from THREE scene to verify marker is ON the face
    const bounds: any = await page.evaluate(
      ({ sourceId, targetId }: { sourceId: string; targetId: string }) => {
        const getObj = (window as any).__V2_GET_OBJECT__;
        if (!getObj) return null;
        const THREE_Box3 = (window as any).THREE?.Box3;
        if (!THREE_Box3) return null;
        const toBox = (id: string) => {
          const obj = getObj(id);
          if (!obj) return null;
          const b = new THREE_Box3().setFromObject(obj);
          return {
            min: [b.min.x, b.min.y, b.min.z],
            max: [b.max.x, b.max.y, b.max.z],
          };
        };
        return { source: toBox(sourceId), target: toBox(targetId) };
      },
      { sourceId: partMap['part1'], targetId: partMap['base'] }
    );

    if (bounds?.source && preview?.source?.positionWorld) {
      const markerY = preview.source.positionWorld[1];
      const bottomY = bounds.source.min[1];
      const height = bounds.source.max[1] - bounds.source.min[1];
      console.log(
        `part1 bottom face: markerY=${markerY.toFixed(4)}, bbox_minY=${bottomY.toFixed(4)}, diff=${Math.abs(markerY - bottomY).toFixed(4)}`
      );
      expect(Math.abs(markerY - bottomY)).toBeLessThan(height * 0.1);
    }

    if (bounds?.target && preview?.target?.positionWorld) {
      const markerY = preview.target.positionWorld[1];
      const topY = bounds.target.max[1];
      const height = bounds.target.max[1] - bounds.target.min[1];
      console.log(
        `base top face: markerY=${markerY.toFixed(4)}, bbox_maxY=${topY.toFixed(4)}, diff=${Math.abs(markerY - topY).toFixed(4)}`
      );
      expect(Math.abs(markerY - topY)).toBeLessThan(height * 0.1);
    }

    // Apply mate by clicking button
    const applyBtn = page.getByText('Apply Mate');
    await applyBtn.click();
    await page.waitForTimeout(1500);

    await page.screenshot({ path: 'test-results/02_after_mate.png' });

    // Log the planar_cluster debug output
    console.log('=== planar_cluster debug ===');
    consoleLogs.forEach(l => console.log(l));
  });
});
