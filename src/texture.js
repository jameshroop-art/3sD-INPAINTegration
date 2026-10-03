export class ConfidenceAtlas {
  constructor(width = 4096, height = 4096) {
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 4096)) {
      throw new Error('Atlas dimensions must be integers between 1 and 4096.');
    }
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 3);
    this.confidence = new Float32Array(width * height);
    this.populated = 0;
  }

  get coverage() {
    return this.populated / this.confidence.length;
  }

  update(samples) {
    if (!Array.isArray(samples)) throw new Error('Projected texel samples must be an array.');
    // Validate the batch before changing any texel.
    for (const sample of samples) {
      if (!sample || !Number.isInteger(sample.index) || sample.index < 0 ||
          sample.index >= this.confidence.length || !Number.isFinite(sample.confidence) ||
          sample.confidence < 0 || sample.confidence > 1 ||
          !Array.isArray(sample.rgb) || sample.rgb.length !== 3 ||
          !Array.from(sample.rgb).every(value => Number.isInteger(value) && value >= 0 && value <= 255) ||
          (sample.visible !== undefined && typeof sample.visible !== 'boolean')) {
        throw new Error('Invalid projected texel sample.');
      }
    }
    let updated = 0;
    for (const { index, rgb, confidence, visible = true } of samples) {
      const weight = Math.fround(confidence);
      if (!visible || weight <= this.confidence[index]) continue;
      if (this.confidence[index] === 0) this.populated++;
      this.pixels.set(rgb, index * 3);
      this.confidence[index] = weight;
      updated++;
    }
    return updated;
  }
}
