class SonoraRecordProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.active = true;
    this.channelMode = ['mono', 'left', 'right', 'stereo'].includes(options.processorOptions?.channelMode)
      ? options.processorOptions.channelMode : 'mono';
    this.captureChannelCount = this.channelMode === 'stereo' ? 2 : 1;
    this.captureBuffers = Array.from({ length: this.captureChannelCount }, () => new Float32Array(2048));
    this.captureOffset = 0;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.flush();
        this.active = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.captureOffset === 0) return;
    const chunks = this.captureBuffers.map(buffer => buffer.slice(0, this.captureOffset));
    this.captureBuffers = Array.from({ length: this.captureChannelCount }, () => new Float32Array(2048));
    this.captureOffset = 0;
    if (this.channelMode === 'stereo') {
      this.port.postMessage({ type: 'audio', channels: chunks }, chunks.map(chunk => chunk.buffer));
    } else {
      this.port.postMessage(chunks[0], [chunks[0].buffer]);
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (const channel of output) channel.fill(0);

    const first = input[0];
    const second = input[1] || first;
    if (first) {
      let sourceOffset = 0;
      while (sourceOffset < first.length) {
        const copied = Math.min(this.captureBuffers[0].length - this.captureOffset, first.length - sourceOffset);
        const left = this.captureBuffers[0];
        if (this.channelMode === 'stereo') {
          left.set(first.subarray(sourceOffset, sourceOffset + copied), this.captureOffset);
          this.captureBuffers[1].set(second.subarray(sourceOffset, sourceOffset + copied), this.captureOffset);
        } else if (this.channelMode === 'left') {
          left.set(first.subarray(sourceOffset, sourceOffset + copied), this.captureOffset);
        } else if (this.channelMode === 'right') {
          left.set(second.subarray(sourceOffset, sourceOffset + copied), this.captureOffset);
        } else if (second === first) {
          left.set(first.subarray(sourceOffset, sourceOffset + copied), this.captureOffset);
        } else {
          for (let index = 0; index < copied; index++) {
            left[this.captureOffset + index] = (first[sourceOffset + index] + second[sourceOffset + index]) * 0.5;
          }
        }
        this.captureOffset += copied;
        sourceOffset += copied;
        if (this.captureOffset === this.captureBuffers[0].length) this.flush();
      }
    }
    return this.active;
  }
}

registerProcessor('sonora-record-processor', SonoraRecordProcessor);
