const puppeteer=require('puppeteer-core'), chromium=require('@sparticuz/chromium'), fs=require('fs'), http=require('http'), path=require('path');
const ROOT=require('path').join(__dirname,'..','..'); const OUT=process.env.SHOTS||require('path').join(__dirname,'shots');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.webmanifest':'application/manifest+json'};
const srv=http.createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p.endsWith('/'))p+='index.html';const f=path.join(ROOT,p);fs.readFile(f,(e,d)=>{if(e){r.writeHead(404);return r.end()}r.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'});r.end(d)})}).listen(8123);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const browser=await puppeteer.launch({args:chromium.args,executablePath:await chromium.executablePath(),headless:'shell'});
  async function shot(name,{w,h,role,url,click,eval:ev,full}){
    const pg=await browser.newPage(); await pg.setViewport({width:w,height:h,deviceScaleFactor:2,isMobile:w<600,hasTouch:w<600});
    const errs=[]; pg.on('pageerror',e=>errs.push(e.message)); pg.on('console',m=>{if(m.type()==='error'&&!/Failed to load resource/.test(m.text()))errs.push(m.text())});
    await pg.setRequestInterception(true);
    pg.on('request',rq=>{const u=rq.url();
      if(u.includes('supabase-js')) return rq.respond({contentType:'text/javascript',body:fs.readFileSync(require('path').join(__dirname,'stub-browser.js'),'utf8')});
      if(u.includes('qrcode-generator')) return rq.respond({contentType:'text/javascript',body:fs.readFileSync(require.resolve('qrcode-generator/qrcode.js'),'utf8')});
      if(u.includes('fonts.g')) return rq.abort(); rq.continue();});
    await pg.evaluateOnNewDocument(r=>{window.__ROLE=r},role||'');
    await pg.goto('http://localhost:8123'+url,{waitUntil:'load'}); await sleep(700);
    if(ev) { await pg.evaluate(ev); await sleep(500); }
    if(click){ await pg.evaluate(click); await sleep(400); }
    await pg.screenshot({path:OUT+'/'+name+'.png',fullPage:!!full});
    console.log(name,errs.length?'ERRORS: '+errs.join(' | '):'ok'); await pg.close();
  }
  fs.mkdirSync(OUT,{recursive:true});
  await shot('m1-patient-login',{w:390,h:780,url:'/app/'});
  await shot('m2-patient-status',{w:390,h:780,url:'/app/?b=BL-20261128-0002&c=123456'});
  await shot('m3-admin-reception',{w:390,h:780,role:'admin',url:'/app/#rec'});
  await shot('m4-admin-more-sheet',{w:390,h:780,role:'admin',url:'/app/#rec',click:"document.querySelector('#nav .tab:last-child').click()"});
  await shot('m5-pharmacy',{w:390,h:780,role:'pharmacy',url:'/app/'});
  await shot('m6-board',{w:390,h:780,url:'/app/#board'});
  await shot('d1-admin-reports',{w:1280,h:800,role:'admin',url:'/app/',ev:"go('adm');ADMPANE='reports';renderAdm()"});
  await shot('d2-reception',{w:1280,h:800,role:'reception',url:'/app/'});
  await browser.close(); srv.close();
})().catch(e=>{console.error('FAILED',e.message);process.exit(1)});
