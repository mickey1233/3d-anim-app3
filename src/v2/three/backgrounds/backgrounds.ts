export const ENVIRONMENT_PRESETS = [
  'warehouse',
  'studio',
  'city',
  'sunset',
  'dawn',
  'night',
  'forest',
  'apartment',
  'lobby',
  'park',
] as const;

export type EnvironmentPreset = (typeof ENVIRONMENT_PRESETS)[number];

export const ENVIRONMENT_IMAGES: Record<EnvironmentPreset, string> = {
  warehouse: '/v2/backgrounds_ai/warehouse.jpg',
  studio: '/v2/backgrounds_ai/studio.jpg',
  city: '/v2/backgrounds_ai/city.jpg',
  sunset: '/v2/backgrounds_ai/sunset.jpg',
  dawn: '/v2/backgrounds_ai/dawn.jpg',
  night: '/v2/backgrounds_ai/night.jpg',
  forest: '/v2/backgrounds_ai/forest.jpg',
  apartment: '/v2/backgrounds_ai/apartment.jpg',
  lobby: '/v2/backgrounds_ai/lobby.jpg',
  park: '/v2/backgrounds_ai/park.jpg',
};
