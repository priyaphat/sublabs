export const cropAspectRatios=Object.freeze({
  original:null,
  free:null,
  '9:16':9/16,
  '1:1':1,
  '4:5':4/5,
  '16:9':16/9,
});

const clamp=(value,minimum,maximum)=>Math.max(minimum,Math.min(maximum,Number(value)));
const evenSize=value=>Math.max(2,Math.round(Number(value)/2)*2);
const evenPosition=(value,maximum)=>Math.max(0,Math.min(maximum,Math.floor(Number(value)/2)*2));
const normalizePair=(first,second)=>{
  let a=Number.isFinite(Number(first))?clamp(first,0,90):0,b=Number.isFinite(Number(second))?clamp(second,0,90):0;
  if(a+b>90){const scale=90/(a+b);a*=scale;b*=scale}
  return[a,b];
};

export function normalizeCropStyle(style={}){
  const cropAspect=Object.hasOwn(cropAspectRatios,style.cropAspect)?style.cropAspect:'original';
  const cropX=Number.isFinite(Number(style.cropX))?clamp(style.cropX,0,100):50;
  const cropY=Number.isFinite(Number(style.cropY))?clamp(style.cropY,0,100):50;
  const [cropLeft,cropRight]=normalizePair(style.cropLeft,style.cropRight),[cropTop,cropBottom]=normalizePair(style.cropTop,style.cropBottom);
  return{...style,cropAspect,cropX,cropY,cropLeft,cropRight,cropTop,cropBottom};
}

export function cropGeometry(sourceWidth,sourceHeight,style={}){
  const width=Math.max(2,Math.round(Number(sourceWidth)||0)),height=Math.max(2,Math.round(Number(sourceHeight)||0)),normalized=normalizeCropStyle(style),ratio=cropAspectRatios[normalized.cropAspect];
  if(normalized.cropAspect==='free'){
    const x=evenPosition(width*normalized.cropLeft/100,width-2),y=evenPosition(height*normalized.cropTop/100,height-2),rightEdge=Math.max(x+2,evenPosition(width*(100-normalized.cropRight)/100,width)),bottomEdge=Math.max(y+2,evenPosition(height*(100-normalized.cropBottom)/100,height)),outputWidth=Math.max(2,rightEdge-x),outputHeight=Math.max(2,bottomEdge-y);
    return{active:x>0||y>0||outputWidth<width||outputHeight<height,aspect:'free',sourceWidth:width,sourceHeight:height,width:outputWidth,height:outputHeight,x,y,cropX:normalized.cropX,cropY:normalized.cropY,cropLeft:normalized.cropLeft,cropRight:normalized.cropRight,cropTop:normalized.cropTop,cropBottom:normalized.cropBottom};
  }
  if(!ratio)return{active:false,aspect:'original',sourceWidth:width,sourceHeight:height,width,height,x:0,y:0,cropX:normalized.cropX,cropY:normalized.cropY};
  const sourceRatio=width/height;
  let outputWidth,outputHeight;
  if(sourceRatio>ratio){outputHeight=evenSize(height);outputWidth=evenSize(outputHeight*ratio)}
  else{outputWidth=evenSize(width);outputHeight=evenSize(outputWidth/ratio)}
  outputWidth=Math.min(evenSize(width),outputWidth);outputHeight=Math.min(evenSize(height),outputHeight);
  const maximumX=Math.max(0,width-outputWidth),maximumY=Math.max(0,height-outputHeight),x=evenPosition(maximumX*normalized.cropX/100,maximumX),y=evenPosition(maximumY*normalized.cropY/100,maximumY);
  return{active:outputWidth!==width||outputHeight!==height,aspect:normalized.cropAspect,sourceWidth:width,sourceHeight:height,width:outputWidth,height:outputHeight,x,y,cropX:normalized.cropX,cropY:normalized.cropY};
}

export function cropFilter(geometry){
  return geometry?.active?`crop=${geometry.width}:${geometry.height}:${geometry.x}:${geometry.y},setsar=1`:'';
}
