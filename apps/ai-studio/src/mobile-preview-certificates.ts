import 'reflect-metadata';
import { webcrypto, randomBytes, X509Certificate as NativeCertificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BasicConstraintsExtension, ExtendedKeyUsage, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, PemConverter, SubjectAlternativeNameExtension, X509Certificate, X509CertificateGenerator } from '@peculiar/x509';

export interface CertificateProtector { seal(value: string): string; open(value: string): string; }
export interface PreviewTlsIdentity { readonly key: string; readonly cert: string; readonly ca: string; readonly publicCertificate: Uint8Array; readonly fingerprint: string; }
const algorithm = {name:'ECDSA',namedCurve:'P-256',hash:'SHA-256'};
const crypto = webcrypto as unknown as Crypto;
const locks = new Map<string,Promise<void>>();

/** Keys stay in main-owned, encrypted device storage. No OS trust store is changed. */
export async function mobilePreviewIdentity(directory: string, addresses: readonly string[], protector: CertificateProtector): Promise<PreviewTlsIdentity> {
  const previous=locks.get(directory)??Promise.resolve();let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),pending=previous.then(()=>gate);
  locks.set(directory,pending);await previous;
  try{return await createIdentity(directory,addresses,protector);}finally{release();if(locks.get(directory)===pending)locks.delete(directory);}
}
async function createIdentity(directory: string, addresses: readonly string[], protector: CertificateProtector): Promise<PreviewTlsIdentity> {
  try {
    await mkdir(directory,{recursive:true,mode:0o700});
    const file=path.join(directory,'authority.json');
    let authority:X509Certificate,privateKey:CryptoKey;
    let saved:unknown;
    try { saved=JSON.parse(await readFile(file,'utf8')); } catch(cause) { if((cause as NodeJS.ErrnoException).code!=='ENOENT')throw cause; }
    if(saved!==undefined){
      if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error();
      const record=saved as Record<string,unknown>;
      if(record.schemaVersion!==1||typeof record.certificate!=='string'||typeof record.encryptedKey!=='string'||Object.keys(record).length!==3)throw Error();
      authority=new X509Certificate(record.certificate);
      if(authority.notAfter.getTime()<Date.now()+86400_000)throw Error();
      privateKey=await crypto.subtle.importKey('pkcs8',PemConverter.decode(protector.open(record.encryptedKey))[0]!,algorithm,false,['sign']);
    }else{
      const keys=await crypto.subtle.generateKey(algorithm,true,['sign','verify']) as CryptoKeyPair;
      authority=await X509CertificateGenerator.createSelfSigned({name:`CN=Haiyue Preview ${randomBytes(4).toString('hex')}`,serialNumber:randomBytes(16).toString('hex'),notBefore:new Date(Date.now()-300_000),notAfter:new Date(Date.now()+365*86400_000),keys,signingAlgorithm:algorithm,extensions:[new BasicConstraintsExtension(true,0,true),new KeyUsagesExtension(KeyUsageFlags.keyCertSign|KeyUsageFlags.cRLSign,true)]},crypto);
      const pem=PemConverter.encode(await crypto.subtle.exportKey('pkcs8',keys.privateKey),'PRIVATE KEY');
      await writeFile(file,JSON.stringify({schemaVersion:1,certificate:authority.toString('pem'),encryptedKey:protector.seal(pem)}),{mode:0o600,flag:'wx'});
      privateKey=keys.privateKey;
    }
    const keys=await crypto.subtle.generateKey(algorithm,true,['sign','verify']) as CryptoKeyPair;
    const certificate=await X509CertificateGenerator.create({subject:'CN=Haiyue Mobile Preview',issuer:authority.subject,serialNumber:randomBytes(16).toString('hex'),notBefore:new Date(Date.now()-300_000),notAfter:new Date(Date.now()+30*86400_000),publicKey:keys.publicKey,signingKey:privateKey,signingAlgorithm:algorithm,extensions:[new BasicConstraintsExtension(false,undefined,true),new KeyUsagesExtension(KeyUsageFlags.digitalSignature,true),new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),new SubjectAlternativeNameExtension([{type:'dns',value:'localhost'},...[...new Set(['127.0.0.1',...addresses])].map(value=>({type:'ip' as const,value}))])]},crypto);
    const cert=certificate.toString('pem'),ca=authority.toString('pem');
    return {key:PemConverter.encode(await crypto.subtle.exportKey('pkcs8',keys.privateKey),'PRIVATE KEY'),cert,ca,publicCertificate:new Uint8Array(authority.rawData),fingerprint:new NativeCertificate(ca).fingerprint256};
  }catch{throw new Error('mobile-preview.certificate-unavailable: 无法创建或读取本机预览证书。');}
}
