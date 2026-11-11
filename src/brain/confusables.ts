/**
 * GENERATED from the Unicode confusables data (confusables.txt 10.0.0, as shipped in the npm
 * package unicode-confusables@0.1.1, MIT) — do not edit by hand; hand additions live in reply.ts.
 * Used by the K2 reply neutralizer (reply.ts). Rule used to build it, per confusables.txt line
 * `from ; prototype`: DIGIT_LIKE_LETTERS = every single-code-point `from` that is \p{L} and whose
 * prototype is O, o, l or 2–9 (the prototypes of the digits), plus O, o, l; TAIL_CONFUSABLES[x] =
 * every single-code-point `from` (not x itself) whose prototype, NFKD and reduced to its letters
 * and digits, is the one character x or X (0 counts as o, 1 as l).
 */

/** Letters (\p{L}) whose confusable prototype is a digit (0 → O, 1 → l, 2–9), plus O, o and l. */
export const DIGIT_LIKE_LETTERS = "IOloƖƧƷƼǀȜȢȣΙΟοσϨІЗОбоӀӠՕօוןסاهھہەߊଠഠဝჿዐᏎᏮᒿᛁᴏᴑℐℑℓℴⲒⲞⲟⳊⳌⳒⵏⵔꓲꓳꙄꝚꝪꝮꞫꬽﮦﮧﮨﮩﮪﮫﮬﮭﺍﺎﻩﻪﻫﻬＩＯｌｏ𐊊𐊒𐊫𐌉𐌚𐐄𐐬𐓂𐓒𐓪𐔖𑢬𑢯𑢵𑢻𑣆𑣈𑣊𑣌𑣕𑣖𑣗𖼨𖼻𝐈𝐎𝐥𝐨𝐼𝑂𝑙𝑜𝑰𝑶𝒍𝒐𝒪𝓁𝓘𝓞𝓵𝓸𝔒𝔩𝔬𝕀𝕆𝕝𝕠𝕴𝕺𝖑𝖔𝖨𝖮𝗅𝗈𝗜𝗢𝗹𝗼𝘐𝘖𝘭𝘰𝙄𝙊𝙡𝙤𝙸𝙾𝚕𝚘𝚰𝚶𝛐𝛔𝛪𝛰𝜊𝜎𝜤𝜪𝝄𝝈𝝞𝝤𝝾𝞂𝞘𝞞𝞸𝞼𞸀𞸤𞹤𞺀𞺄";

/** Code points confusable with a letter of "reply yes or no", by letter. */
export const TAIL_CONFUSABLES: Record<'r' | 'e' | 'p' | 'l' | 'y' | 's' | 'o' | 'n', string> = {
  r: "ƦɍɼɽгґғᎡᏒᖇᴦᵲℛℜℝ⒭ⲅꓣꭇꭈꮁ𐒴𖼵𝈖𝐑𝐫𝑅𝑟𝑹𝒓𝓇𝓡𝓻𝔯𝕣𝕽𝖗𝖱𝗋𝗥𝗿𝘙𝘳𝙍𝙧𝚁𝚛🄡",
  e: "ĚěɆɇΕЕеҽҿᎬ℮ℯℰⅇ⋿⒠ⴹꓰꬲＥｅ𐊆𑢦𑢮𝐄𝐞𝐸𝑒𝑬𝒆𝓔𝓮𝔈𝔢𝔼𝕖𝕰𝖊𝖤𝖾𝗘𝗲𝘌𝘦𝙀𝙚𝙴𝚎𝚬𝛦𝜠𝝚𝞔🄔",
  p: "ƤƥΡρϱРрᏢᑭᑶᑷᒆᵽℙ⍴⒫ⲢⲣꓑＰｐ𐊕𝐏𝐩𝑃𝑝𝑷𝒑𝒫𝓅𝓟𝓹𝔓𝔭𝕡𝕻𝖕𝖯𝗉𝗣𝗽𝘗𝘱𝙋𝙥𝙿𝚙𝚸𝛒𝛠𝛲𝜌𝜚𝜬𝝆𝝔𝝦𝞀𝞎𝞠𝞺𝟈🄟",
  l: "1I|ĿŀŁłƖƗƚǀɫɭΙІӀ׀וןױإا١ٳ۱ߊᏞᒪᒶᒷᛁℐℑℒℓⅠⅬⅼ∣⏽⑴⒈⒧ⲒⳐⵏꓡꓲﴼﴽﺇﺈﺍﺎＩｌ￨𐊊𐌉𐌠𐐛𐔦𑢣𑢲𖼖𖼨𝈪𝐈𝐋𝐥𝐼𝐿𝑙𝑰𝑳𝒍𝓁𝓘𝓛𝓵𝔏𝔩𝕀𝕃𝕝𝕴𝕷𝖑𝖨𝖫𝗅𝗜𝗟𝗹𝘐𝘓𝘭𝙄𝙇𝙡𝙸𝙻𝚕𝚰𝛪𝜤𝝞𝞘𝟏𝟙𝟣𝟭𝟷𞣇𞸀𞺀🄂🄘🄛",
  y: "¥ƳƴɎɏɣʏΥγϒУуҮүҰұყᎩᎽᶌỿℽ⒴ⲨꓬꭚＹｙ𐊲𑢤𑣜𖽃𝐘𝐲𝑌𝑦𝒀𝒚𝒴𝓎𝓨𝔂𝔜𝔶𝕐𝕪𝖄𝖞𝖸𝗒𝗬𝘆𝘠𝘺𝙔𝙮𝚈𝚢𝚼𝛄𝛶𝛾𝜰𝜸𝝪𝝲𝞤𝞬🄨",
  s: "ƽʂЅѕՏᏕᏚᵴ⒮ꓢꜱꮪＳｓ𐊖𐐠𐑈𑣁𖼺𝐒𝐬𝑆𝑠𝑺𝒔𝒮𝓈𝓢𝓼𝔖𝔰𝕊𝕤𝕾𝖘𝖲𝗌𝗦𝘀𝘚𝘴𝙎𝙨𝚂𝚜🄢🄪",
  o: "0ØøƟƠơǑǒǾɵΘΟθοσϑϴОоѲѳӨөՕօסه٥ھہە۵ۿ߀०০੦૦ଠ୦௦ం౦ಂ೦ംഠ൦ං๐໐တဝ၀ჿዐᎤᎾᏫᴏᴑᵒ⁰ℴ⊖⊝⍬⒪Ⲟⲟⴱⵁⵔ〇ꓳꝊꝋꬽꬾꭴꮎꮻﮦﮧﮨﮩﮪﮫﮬﮭﳙﻩﻪﻫﻬＯｏ𐊒𐊫𐐄𐐬𐓂𐓪𐔖𑓐𑢵𑣈𑣗𑣠𝈚𝐎𝐨𝑂𝑜𝑶𝒐𝒪𝓞𝓸𝔒𝔬𝕆𝕠𝕺𝖔𝖮𝗈𝗢𝗼𝘖𝘰𝙊𝙤𝙾𝚘𝚯𝚶𝚹𝛉𝛐𝛔𝛝𝛩𝛰𝛳𝜃𝜊𝜎𝜗𝜣𝜪𝜭𝜽𝝄𝝈𝝑𝝝𝝤𝝧𝝷𝝾𝞂𝞋𝞗𝞞𝞡𝞱𝞸𝞼𝟅𝟎𝟘𝟢𝟬𝟶𞸤𞹤𞺄🄀🄁🄞🜔",
  n: "ŉƝƞɳΝηոռᵰℕ⒩ⲚꓠＮ𐆎𐔓𝐍𝐧𝑁𝑛𝑵𝒏𝒩𝓃𝓝𝓷𝔑𝔫𝕟𝕹𝖓𝖭𝗇𝗡𝗻𝘕𝘯𝙉𝙣𝙽𝚗𝚴𝛈𝛮𝜂𝜨𝜼𝝢𝝶𝞜𝞰🄝",
};
