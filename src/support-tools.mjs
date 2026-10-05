import {z} from 'zod';
const pid=z.number().int().min(1).max(0xffffffff),address=z.string().regex(/^(0x[\da-f]+|\d+)$/i),length=z.number().int().min(1).max(1048576);
const type=z.enum(['u8','i8','u16','i16','u32','i32','u64','i64','f32','f64']);
export const supportTools=[
 ['status','Read support permissions and the selected console connection.',{}],
 ['probe','Check debugger and FTP ports. Never opens the payload loader.',{}],
 ['connect','Connect the support debugger to the owner-selected console.',{}],
 ['processes','List console processes.',{}],
 ['process_info','Read console process identity.',{pid}],
 ['maps','Read a console process memory map.',{pid}],
 ['memory_read','Read bounded live console memory.',{pid,address,length:length.optional()}],
 ['memory_readv','Read up to 128 live ranges, at most 1 MiB total.',{pid,ranges:z.array(z.object({address,length}).strict()).min(1).max(128)}],
 ['memory_inspect','Decode typed fields in live console memory.',{pid,address,fields:z.array(z.object({name:z.string().max(80),offset:z.number().int().min(0).max(65528),type}).strict()).min(1).max(64)}],
 ['memory_strings','Read strings from bounded live console memory.',{pid,address,length:length.optional(),minLength:z.number().int().min(2).max(128).optional(),encoding:z.enum(['ascii','utf16le']).optional()}],
 ['pointer_resolve','Follow a bounded live 64-bit pointer chain.',{pid,base:address,offsets:z.array(z.string().regex(/^-?(0x[\da-f]+|\d+)$/i)).max(16)}],
 ['ftp_list','List a console FTP directory. No PC files are exposed.',{remote:z.string().max(1024)}],
 ['ftp_read','Read a console file (maximum 4 MiB) as UTF-8 or base64. No local PC paths.',{remote:z.string().max(1024),encoding:z.enum(['utf8','base64']).optional()}],
 ['memory_write','Compare expected bytes, write and verify up to 4096 bytes. Requires owner support-actions permission; not atomic against the running console.',{pid,address,expectedHex:z.string().regex(/^(?:[a-f\d]{2})+$/i).max(8192),hex:z.string().regex(/^(?:[a-f\d]{2})+$/i).max(8192)}],
 ['payload_send','Send one verified ELF to the console loader. Requires owner support-actions permission. Transfer completion does not prove execution.',{name:z.string().regex(/^[\w.-]+\.elf$/i).max(100),sha256:z.string().regex(/^[a-f\d]{64}$/),base64:z.string().min(1).max(44739244)}]
];
export const supportSchemas=new Map(supportTools.map(([name,,shape])=>[name,z.object(shape).strict()]));
