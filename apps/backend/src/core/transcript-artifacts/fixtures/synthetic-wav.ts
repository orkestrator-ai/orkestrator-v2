/**
 * A deterministic PCM WAV (16-bit mono sine) for media streaming tests: the
 * same arguments always produce the same bytes.
 */
export function syntheticWav(seconds: number, sampleRate = 8_000, frequency = 440): Uint8Array {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples; index++) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12_000);
    view.setInt16(44 + index * 2, value, true);
  }
  return bytes;
}
