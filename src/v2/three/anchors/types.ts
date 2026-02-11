export type Anchor =
  | {
      type: 'local';
      partId: string;
      position: [number, number, number];
    }
  | {
      type: 'face';
      partId: string;
      faceId: string;
      position: [number, number, number];
      normal: [number, number, number];
      tangent?: [number, number, number];
    };

