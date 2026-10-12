import { Platform } from 'react-native';
import * as Picker from 'expo-document-picker';
import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { disposePhoto } from './photos';
import type { Client } from './client';
import { FILE_BYTES, DOCUMENT_BYTES, validateDocuments, validDocumentName, type SelectedDocument } from './documents';

const hash = async (data:Uint8Array)=>Array.from(new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256,data as BufferSource)),b=>b.toString(16).padStart(2,'0')).join('');
export async function pickDocument(api:Client,isCurrent:()=>boolean):Promise<SelectedDocument|undefined>{
  if(Platform.OS==='web')return {name:'sample-plan.md',text:'# Weekend plan\nVisit the library on Saturday.\nLunch budget: $25.'};
  const picked=await Picker.getDocumentAsync({type:['text/plain','text/markdown','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],copyToCacheDirectory:true,multiple:false});
  if(picked.canceled||!picked.assets[0])return;
  const asset=picked.assets[0];
  try{
    if(!isCurrent())return;
    if(!validDocumentName(asset.name))throw new Error('Choose a TXT, MD, PDF or DOCX file with a plain filename.');
    const rich=/\.(pdf|docx)$/i.test(asset.name),file=new File(asset.uri);
    if(!file.exists||file.size<1||file.size>(rich?FILE_BYTES:DOCUMENT_BYTES))throw new Error(rich?'Choose a file up to 8 MiB.':'Choose text up to 64 KiB.');
    const expectedSize=file.size,bytes=await file.bytes();if(!isCurrent())return;
    if(bytes.length!==expectedSize||bytes.length>(rich?FILE_BYTES:DOCUMENT_BYTES))throw new Error('The chosen file changed while being read. Choose it again.');
    let document:SelectedDocument;
    if(rich){
      const capability=await api.json<any>('/api/ai/documents/extraction-capabilities');if(!isCurrent())return;
      const format=asset.name.split('.').pop()!.toLowerCase();
      if(capability?.protocol!=='tli-document-extraction-v1'||capability.formats?.[format]?.available!==true)throw new Error(capability.formats?.[format]?.reason||'This host cannot extract that document format.');
      const original=await hash(bytes);if(!isCurrent())return;
      const response=await api.upload<any>('/api/ai/documents/extract?name='+encodeURIComponent(asset.name),asset.uri,asset.name);if(!isCurrent())return;
      document=response.document;
      if(response.protocol!=='tli-document-extraction-v1'||response.ok!==true||!document||document.name!==asset.name)throw new Error('The host returned an inconsistent document.');
      validateDocuments([document]);
      if(document.extraction!.origin.original_sha256!==original||document.extraction!.origin.original_bytes!==bytes.length||document.extraction!.origin.text_sha256!==await hash(new TextEncoder().encode(document.text)))throw new Error('The reviewed text does not match the chosen document.');
    }else{document={name:asset.name,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/\r\n?/g,'\n')};validateDocuments([document]);}
    return isCurrent()?document:undefined;
  }finally{await disposePhoto(asset.uri);}
}
