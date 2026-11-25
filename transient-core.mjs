const MAX_WINDOWS=120000;
export async function detectTransientFrames(channels,sampleRate,{startFrame=0,endFrame=channels?.[0]?.length,sensitivity=.55,minSpacingMs=90,windowMs=10}={}){
 if(!Array.isArray(channels)||!channels.length||channels.length>8||!Number.isInteger(sampleRate)||sampleRate<8000||sampleRate>192000||
 !Number.isInteger(startFrame)||!Number.isInteger(endFrame)||startFrame<0||endFrame<=startFrame||!Number.isFinite(sensitivity)||sensitivity<0||sensitivity>1||
 !Number.isFinite(minSpacingMs)||minSpacingMs<40||minSpacingMs>500||!Number.isFinite(windowMs)||windowMs<5||windowMs>50)return null;
 const length=channels[0]?.length;if(!Number.isSafeInteger(length)||channels.some(c=>!c||c.length!==length)||endFrame>length)return null;
 const size=Math.round(sampleRate*windowMs/1000),count=Math.ceil((endFrame-startFrame)/size);if(count<2||count>MAX_WINDOWS)return null;
 const env=new Float32Array(count);
 for(let w=0;w<count;w++){const a=startFrame+w*size,z=Math.min(endFrame,a+size);let sum=0,n=0;for(const c of channels)for(let i=a;i<z;i++){const v=c[i];if(Number.isFinite(v)){sum+=v*v;n++;}}
 env[w]=n?Math.sqrt(sum/n):0;if((w&4095)===4095)await new Promise(r=>setTimeout(r,0));}
 let max=0;for(const v of env)max=Math.max(max,v);if(max<1e-7)return[];const sorted=new Float32Array(env);sorted.sort();const floor=sorted[Math.floor((count-1)*.2)],range=max-floor;if(range<1e-7)return[];
 const ratio=.08+(1-sensitivity)*.72,high=floor+range*ratio,low=floor+range*ratio*.48,minRise=Math.max(max*.025,range*(.04+(1-sensitivity)*.3)),gap=sampleRate*minSpacingMs/1000,out=[];let armed=true,quiet=0,last=-Infinity;
 for(let i=1;i<count;i++){const v=env[i];if(!armed){if(v<=low)quiet++;else quiet=0;if(quiet>=2){armed=true;quiet=0;}continue;}
 if(env[i-1]<high&&v>=high&&v-env[i-1]>=minRise){let at=i;while(at>0&&env[at-1]>low)at--;const frame=Math.min(endFrame-1,startFrame+at*size);if(frame-last>=gap){out.push(frame);last=frame;armed=false;quiet=0;}}
 if((i&4095)===4095)await new Promise(r=>setTimeout(r,0));}return out;
}