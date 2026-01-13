import * as THREE from 'three';

export function computeSmartOBB(mesh: THREE.Mesh): { center: THREE.Vector3, size: THREE.Vector3, basis: THREE.Matrix4 } {
    const geometry = mesh.geometry;
    geometry.computeBoundingBox();

    // 0. Default AABB (Fallback)
    const box = geometry.boundingBox!;
    const sizeAABB = new THREE.Vector3(); box.getSize(sizeAABB);
    const centerAABB = new THREE.Vector3(); box.getCenter(centerAABB);
    const basisAABB = new THREE.Matrix4().identity(); // Identity Rotation
    
    // If no position attribute, just return AABB
    if (!geometry.attributes.position) {
         return { center: centerAABB, size: sizeAABB, basis: basisAABB };
    }

    const positions = geometry.attributes.position;
    const count = positions.count;
    
    // Optimization: stride
    const stride = count > 5000 ? Math.floor(count / 2000) : 1;
    let sampleCount = 0;

    // 1. Mean
    const mean = new THREE.Vector3();
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i+=stride) {
        v.fromBufferAttribute(positions, i);
        mean.add(v);
        sampleCount++;
    }
    mean.divideScalar(sampleCount);

    // 2. Covariance
    let c11=0, c12=0, c13=0, c22=0, c23=0, c33=0;
    for (let i = 0; i < count; i+=stride) {
        v.fromBufferAttribute(positions, i);
        v.sub(mean);
        c11 += v.x*v.x; c12 += v.x*v.y; c13 += v.x*v.z;
        c22 += v.y*v.y; c23 += v.y*v.z; c33 += v.z*v.z;
    }
    c11/=sampleCount; c12/=sampleCount; c13/=sampleCount;
    c22/=sampleCount; c23/=sampleCount; c33/=sampleCount;

    // 3. Eigen Decomposition (Symmetric 3x3)
    const eigenVectors = getEigenVectors([ [c11, c12, c13], [c12, c22, c23], [c13, c23, c33] ]);
    
    // 4. Basis
    const basisPCA = new THREE.Matrix4();
    basisPCA.makeBasis(eigenVectors[0], eigenVectors[1], eigenVectors[2]);
    
    // 5. Min/Max Project
    const inverseBasis = basisPCA.clone().invert();
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    
    for(let i=0; i<count; i+=stride) {
        v.fromBufferAttribute(positions, i);
        v.applyMatrix4(inverseBasis);
        min.min(v);
        max.max(v);
    }
    
    const sizePCA = new THREE.Vector3().subVectors(max, min);
    const centerPCA = new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5);
    centerPCA.applyMatrix4(basisPCA);

    // 6. HYBRID CHECK: Volume Comparison
    // We prefer AABB (Identity) if it's "close enough" because it aligns with world axes (or baked local axes) which usually look better.
    // Small volume = Tighter fit.
    const volumeAABB = sizeAABB.x * sizeAABB.y * sizeAABB.z;
    const volumePCA = sizePCA.x * sizePCA.y * sizePCA.z;

    // If AABB is within 5% of PCA volume (or smaller), use AABB.
    // This handles the "Perfect Square/Circle" case where PCA picks arbitrary diagonal.
    // Also handles "Aligned Part" case.
    // PCA could be slightly smaller due to noise, so we give a buffer to AABB preference.
    if (volumeAABB <= volumePCA * 1.05) {
        return { center: centerAABB, size: sizeAABB, basis: basisAABB };
    }

    return { center: centerPCA, size: sizePCA, basis: basisPCA };
}

// Simple Power Iteration / Jacobi for 3x3 (Approximation)
function getEigenVectors(m: number[][]): THREE.Vector3[] {
    // Ideally we assume axes are roughly XYZ, but let's try to refine them.
    // For this specific problem (flat object), finding the NORMAL (smallest variance) is key.
    
    // Quick diagonalization helper? 
    // Let's use a known robust snippet or just assume standard alignment if variances are distinct?
    // No, we need rotation.
    
    // Jacobi Cyclic Algorithm Implementation
    let V = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1]
    ];
    let A = [
        [m[0][0], m[0][1], m[0][2]],
        [m[1][0], m[1][1], m[1][2]],
        [m[2][0], m[2][1], m[2][2]]
    ];
    
    const maxIter = 50;
    for (let iter = 0; iter < maxIter; iter++) {
        let maxOffDiag = 0;
        let p=0, q=1;
        for(let i=0; i<3; i++) {
            for(let j=i+1; j<3; j++) {
                if(Math.abs(A[i][j]) > maxOffDiag) {
                    maxOffDiag = Math.abs(A[i][j]);
                    p=i; q=j;
                }
            }
        }
        
        if (maxOffDiag < 1e-9) break;
        
        const phi = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        
        // A' = J^T * A * J
        // Update diagonal and off-diagonal elements
        // This math is tedious to expand here without matrix lib.
        // Simpler: Just rotate the V (Eigenvectors) blindly? No.
        
        // Let's use a simpler heuristic for box fitting:
        // Try multiple rotations?
        
        // Actually, let's stick to the simplest:
        // Just return Identity if complex.
        // BUT, since I must fix the user issue, I will include a small helper I know works.
        // (Simulating "Diagonalize" via ThreeJS Matrices if possible?)
        // No, ThreeJS doesn't have diagonalize.
        
        // I will implement the rotation update for V and A properly.
        const app = A[p][p];
        const aqq = A[q][q];
        const apq = A[p][q];
        
        A[p][p] = c*c*app - 2*s*c*apq + s*s*aqq;
        A[q][q] = s*s*app + 2*s*c*apq + c*c*aqq;
        A[p][q] = 0; // elimination
        A[q][p] = 0;
        
        for(let k=0; k<3; k++) {
            if(k!==p && k!==q) {
                const akp = A[k][p];
                const akq = A[k][q];
                A[k][p] = c*akp - s*akq;
                A[p][k] = A[k][p];
                A[k][q] = s*akp + c*akq;
                A[q][k] = A[k][q];
            }
        }
        
        // Update Eigenvectors V
        for(let k=0; k<3; k++) {
            const vkp = V[k][p];
            const vkq = V[k][q];
            V[k][p] = c*vkp - s*vkq;
            V[k][q] = s*vkp + c*vkq;
        }
    }
    
    // Sort by eigenvalue (diagonal A) desc?
    // Not strictly needed for OBB, but nice for "X axis = major".
    
    return [
        new THREE.Vector3(V[0][0], V[1][0], V[2][0]).normalize(),
        new THREE.Vector3(V[0][1], V[1][1], V[2][1]).normalize(),
        new THREE.Vector3(V[0][2], V[1][2], V[2][2]).normalize()
    ];
}
