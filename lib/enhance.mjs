const even=value=>Math.max(2,Math.round(Number(value)/2)*2);

export function fullHdGeometry(width,height){
  width=Math.max(2,Number(width)||2);height=Math.max(2,Number(height)||2);
  const portrait=height>width,maximumWidth=portrait?1080:1920,maximumHeight=portrait?1920:1080,scale=Math.min(maximumWidth/width,maximumHeight/height);
  return{width:even(width*scale),height:even(height*scale)};
}

export function enhancementFilters(width,height,enabled=false){
  if(!enabled)return[];
  const target=fullHdGeometry(width,height);
  return['hqdn3d=1.2:1.2:6:6',`scale=${target.width}:${target.height}:flags=lanczos`,'unsharp=5:5:0.45:5:5:0.0'];
}
