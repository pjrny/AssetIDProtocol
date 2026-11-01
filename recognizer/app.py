from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Header
from pydantic import BaseModel
import cv2, numpy as np, base64, os, hmac

app=FastAPI(title="Asset Passport Visual Recognizer",version="0.2")
SECRET=os.getenv("RECOGNIZER_SECRET","")
MODEL="orb-phash-v1"

def auth(value):
    # Fail closed: an unset secret must never leave the recognizer open.
    if not SECRET: raise HTTPException(503,"RECOGNIZER_SECRET is not configured")
    if not hmac.compare_digest(value or "",SECRET): raise HTTPException(401,"invalid service secret")
MAX_BYTES=int(os.getenv("RECOGNIZER_MAX_BYTES","10000000"))
def decode(data):
    if len(data)>MAX_BYTES: raise HTTPException(413,"file too large")
    im=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_COLOR)
    if im is None: raise HTTPException(400,"invalid image")
    h,w=im.shape[:2]
    scale=min(1.0,1400/max(h,w))
    if scale<1: im=cv2.resize(im,(int(w*scale),int(h*scale)),interpolation=cv2.INTER_AREA)
    return im

def dhash(gray):
    x=cv2.resize(gray,(9,8),interpolation=cv2.INTER_AREA)
    bits=(x[:,1:]>x[:,:-1]).flatten()
    return ''.join(f'{b:02x}' for b in np.packbits(bits))
def phash(gray):
    x=cv2.resize(gray,(32,32),interpolation=cv2.INTER_AREA).astype(np.float32)
    d=cv2.dct(x)[:8,:8]; med=np.median(d[1:]); bits=(d>med).flatten()
    return ''.join(f'{b:02x}' for b in np.packbits(bits))
def hsv_hist(im):
    hsv=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
    hist=cv2.calcHist([hsv],[0,1],None,[16,8],[0,180,0,256]); cv2.normalize(hist,hist)
    return [round(float(x),6) for x in hist.flatten()]
def features(im):
    gray=cv2.cvtColor(im,cv2.COLOR_BGR2GRAY)
    orb=cv2.ORB_create(nfeatures=900,scaleFactor=1.2,nlevels=8,fastThreshold=12)
    kp,des=orb.detectAndCompute(gray,None)
    if des is None: des=np.empty((0,32),dtype=np.uint8)
    # cap descriptor count for transport
    des=des[:700]
    return {"model":MODEL,"phash":phash(gray),"dhash":dhash(gray),"hist":hsv_hist(im),
            "orb":base64.b64encode(des.tobytes()).decode(),"orb_rows":int(len(des)),"shape":[int(im.shape[1]),int(im.shape[0])]}
def ham(a,b):
    try:return (int(a,16)^int(b,16)).bit_count()
    except Exception:return 64
def orb_decode(f):
    raw=base64.b64decode(f.get('orb','')); n=int(f.get('orb_rows',0))
    return np.frombuffer(raw,dtype=np.uint8).reshape(n,32) if n and len(raw)==n*32 else np.empty((0,32),np.uint8)
def score(q,c):
    hp=max(0,1-ham(q['phash'],c['phash'])/64); hd=max(0,1-ham(q['dhash'],c['dhash'])/64)
    a=np.array(q['hist'],np.float32); b=np.array(c['hist'],np.float32)
    hs=max(0,float(cv2.compareHist(a,b,cv2.HISTCMP_CORREL))) if len(a)==len(b) else 0
    qd,cd=orb_decode(q),orb_decode(c); oscore=0; good=0
    if len(qd)>=8 and len(cd)>=8:
        pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(qd,cd,k=2)
        good=sum(1 for p in pairs if len(p)==2 and p[0].distance<0.72*p[1].distance)
        oscore=min(1,good/45)
    # ORB dominates crops/perspective; hashes dominate exact/screenshot copies.
    total=.45*oscore+.25*hp+.12*hd+.18*hs
    return round(total,4),good,{"orb":round(oscore,3),"phash":round(hp,3),"dhash":round(hd,3),"color":round(hs,3)}

@app.get('/health')
def health(): return {"ok":True,"model":MODEL}
@app.post('/extract')
async def extract(file:UploadFile=File(...),x_service_secret:str|None=Header(default=None)):
    auth(x_service_secret); return features(decode(await file.read()))
class Candidate(BaseModel): assetId:str; features:dict
class MatchBody(BaseModel): candidates:list[Candidate]
@app.post('/match')
async def match(file:UploadFile=File(...),candidates:str=Form(...),x_service_secret:str|None=Header(default=None)):
    import json
    auth(x_service_secret); q=features(decode(await file.read()))
    try: cs=[Candidate(**x) for x in json.loads(candidates)]
    except Exception: raise HTTPException(400,"invalid candidates JSON")
    out=[]
    for c in cs:
        if c.features.get('model')!=MODEL: continue
        total,good,parts=score(q,c.features)
        out.append({"assetId":c.assetId,"score":total,"goodKeypoints":good,"parts":parts})
    out.sort(key=lambda x:x['score'],reverse=True)
    best=out[0] if out else None
    # conservative demo threshold; calibrate with your own positive/negative corpus.
    accepted=bool(best and best['score']>=0.56 and (best['goodKeypoints']>=10 or best['parts']['phash']>=0.82))
    return {"matched":accepted,"best":best,"alternatives":out[:5],"model":MODEL}
