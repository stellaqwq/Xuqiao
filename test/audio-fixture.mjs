export function wav({ rate=32000, channels=1, bits=16, float=false, seconds=.12 }={}) {
  const frames=Math.ceil(rate*seconds),align=channels*bits/8,bytes=Buffer.alloc(44+frames*align);
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(float?3:1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*align,28);bytes.writeUInt16LE(align,32);bytes.writeUInt16LE(bits,34);bytes.write('data',36);bytes.writeUInt32LE(frames*align,40);
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){
    const value=Math.sin(i*2*Math.PI*440/rate)*.4,offset=44+i*align+c*bits/8;
    if(float){if(bits===32)bytes.writeFloatLE(value,offset);else bytes.writeDoubleLE(value,offset);}
    else if(bits===8)bytes[offset]=128+Math.round(value*127);
    else bytes.writeIntLE(Math.round(value*(2**(bits-1)-1)),offset,bits/8);
  }
  return bytes;
}
