"""DEMO watermark processor. Embeds a watermark ID with repetition into RGB LSBs.
This survives neither screenshots nor ordinary recompression reliably. It is included to prove
end-to-end payload handling. Replace it with a robust frequency-domain/forensic watermark provider
before production. Usage: python scripts/process_asset.py embed input.png output.png WATERMARK_ID
       python scripts/process_asset.py extract output.png
"""
from PIL import Image
import sys
MAGIC=b"APW1"
def bits(data):
    for b in data:
        for i in range(7,-1,-1): yield (b>>i)&1
def embed(src,dst,payload):
    im=Image.open(src).convert('RGB'); px=list(im.getdata()); raw=payload.encode()
    packet=MAGIC+len(raw).to_bytes(2,'big')+raw
    stream=list(bits(packet))*5
    if len(stream)>len(px)*3: raise ValueError('image too small')
    vals=[c for p in px for c in p]
    for i,b in enumerate(stream): vals[i]=(vals[i]&254)|b
    im.putdata([tuple(vals[i:i+3]) for i in range(0,len(vals),3)]); im.save(dst,format='PNG')
def extract(src):
    """Decode all five repeated packets and take a per-bit majority vote."""
    im=Image.open(src).convert('RGB'); vals=[c for p in im.getdata() for c in p]
    rawbits=[v&1 for v in vals]
    def to_bytes(bitlist):
        out=bytearray()
        for j in range(0,len(bitlist)-7,8):
            v=0
            for b in bitlist[j:j+8]: v=(v<<1)|b
            out.append(v)
        return bytes(out)
    head=to_bytes(rawbits[:48])
    if head[:4]!=MAGIC: raise ValueError('watermark not found')
    n=int.from_bytes(head[4:6],'big')
    plen=(6+n)*8
    copies=[rawbits[k*plen:(k+1)*plen] for k in range(5) if (k+1)*plen<=len(rawbits)]
    voted=[1 if sum(c[i] for c in copies)*2>len(copies) else 0 for i in range(plen)]
    packet=to_bytes(voted)
    if packet[:4]!=MAGIC: raise ValueError('watermark corrupted')
    return packet[6:6+n].decode()
if __name__=='__main__':
    if len(sys.argv)<3: print(__doc__); sys.exit(2)
    if sys.argv[1]=='embed': embed(sys.argv[2],sys.argv[3],sys.argv[4]); print(sys.argv[3])
    elif sys.argv[1]=='extract': print(extract(sys.argv[2]))
