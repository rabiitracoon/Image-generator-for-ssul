import {readFile} from 'node:fs/promises';
// Stored ZIP entries stream one image at a time; UTF-8 names work across Macs/PCs.
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export async function* zipEntries(entries){
 let offset=0;const directory=[];
 for(const entry of entries){
  const name=Buffer.from(entry.name,'utf8'),data=entry.data??await readFile(entry.file),crc=crc32(data),header=Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  directory.push(central,name);offset+=header.length+name.length+data.length;
  yield header;yield name;yield data;
 }
 const size=directory.reduce((sum,b)=>sum+b.length,0),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);
 for(const chunk of directory)yield chunk;yield end;
}
