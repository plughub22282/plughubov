const yauzl=require('yauzl');
const ZIP='C:/Users/podkop/AppData/Local/Temp/plugin-exe.zip';
const PEEK=1024*1024;
const t0=Date.now();
const log=(...a)=>process.stdout.write(a.join(' ')+'\n');
yauzl.open(ZIP,{lazyEntries:true,autoClose:true},(err,zip)=>{
  if(err){log('open err',err.message);return;}
  log('opened, entryCount', zip.entryCount);
  zip.on('entry',(entry)=>{
    log('entry:', entry.fileName, 'usize', entry.uncompressedSize, 'csize', entry.compressedSize);
    if(entry.fileName.endsWith('/')){zip.readEntry();return;}
    const ts=Date.now();
    zip.openReadStream(entry,(e,stream)=>{
      if(e){log('stream err',e.message);return;}
      let read=0;
      stream.on('data',(c)=>{read+=c.length;if(read>=PEEK){log('reached PEEK at ms', Date.now()-ts, 'read', read);stream.destroy();}});
      stream.on('end',()=>log('stream END, read',read,'ms',Date.now()-ts));
      stream.on('close',()=>{log('stream CLOSE, read',read,'ms',Date.now()-ts, 'TOTAL', Date.now()-t0);});
      stream.on('error',(er)=>log('stream ERROR',er.message,'read',read,'ms',Date.now()-ts));
    });
  });
  zip.on('end',()=>log('zip END event, TOTAL', Date.now()-t0));
  zip.readEntry();
});
setTimeout(()=>{log('--- 130s watchdog fired, still running, TOTAL', Date.now()-t0);process.exit(0);}, 130000);
