import {it,expect} from 'vitest';
import {csv} from '../src/lib/analytics/csv.js';
it('escapes comma, quote, newline and emits CRLF',()=>{expect(csv(['a','b'],[['a,b','say "yes"'],['line\nnext',null]])).toBe('a,b\r\n"a,b","say ""yes"""\r\n"line\nnext",\r\n');});
