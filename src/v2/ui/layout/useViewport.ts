import React from 'react';

export function useViewport() {
  const [size, setSize] = React.useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));

  React.useEffect(() => {
    const handle = () => {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    };
    handle();
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);

  return size;
}
