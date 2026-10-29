/* ══════════════════════════════════════════════════════════════
   KivoGenres — единый справочник жанров.
   Используется и плеером (index-test.html), и голосовым
   помощником (voice-assistant.js), чтобы «рок», «роковое» и
   тег "Rock" означали одно и то же.

   Откуда берётся жанр трека (по убыванию достоверности):
     1. тег ID3 (TCON) — самый точный;
     2. папка, в которой лежит файл (Music/Rock/…);
     3. исполнитель из таблицы ниже — если ни тегов, ни папок нет.

   API:
     KivoGenres.detect(text)        → ['рок']          (все жанры в тексте)
     KivoGenres.consume(text)       → {ids, rest}      (что осталось от фразы)
     KivoGenres.detectFolder(path)  → ['рок']
     KivoGenres.detectArtist(name)  → 'рок' | null
     KivoGenres.fromTag(raw)        → ['рок'] | ['Trip-Hop']
     KivoGenres.label(id)           → 'Рок'
     KivoGenres.isKnown(id)         → true/false
   ══════════════════════════════════════════════════════════════ */
(function (global) {
    'use strict';

    // Порядок важен: специфичные жанры проверяются раньше общих,
    // поэтому «фолк-рок» и «поп-рок» не схлопываются в «поп».
    // stems — основы слов; окончание отсекается в tokenMatches().
    const GENRES = [
        {
            id: 'металл', label: 'Металл',
            stems: ['метал', 'metal', 'metalcore', 'металкор', 'дэт', 'трэш', 'thrash',
                'дум', 'doom', 'хэви', 'heavy', 'слэм', 'грайнд', 'индастриал', 'industrial']
        },
        {
            id: 'рок', label: 'Рок',
            stems: ['рок', 'rock', 'рокнрол', 'роков', 'инди', 'indie', 'альтернатив', 'alternative',
                'гранж', 'grunge', 'панк', 'punk', 'хардкор', 'hardcore', 'гараж', 'garage',
                'рокер', 'rocker', 'прогрессив', 'progressive', 'психодел', 'psychedelic']
        },
        {
            id: 'джаз', label: 'Джаз',
            stems: ['джаз', 'jazz', 'джазов', 'свинг', 'swing', 'боссанова', 'bossa',
                'бигбэнд', 'bigband', 'рэгтайм', 'ragtime', 'bebop', 'bebob']
        },
        {
            id: 'блюз', label: 'Блюз',
            stems: ['блюз', 'blues', 'блюзов', 'буги', 'boogie']
        },
        {
            id: 'электроника', label: 'Электроника',
            stems: ['электрон', 'electronic', 'electro', 'хаус', 'house', 'техно', 'techno',
                'транс', 'trance', 'дабстеп', 'dubstep', 'драм', 'drum', 'dnb', 'edm', 'синти', 'synth',
                'synthwave', 'брейкбит', 'breakbeat', 'гараж', 'garage', 'бейс', 'bass',
                'triphop', 'hardstyle', 'трэпкор', 'edmgenre']
        },
        {
            // рэп — отдельно от хип-хопа: в тегах это разные жанры,
            // и «включи рэп» должно находить именно рэп
            id: 'рэп', label: 'Рэп',
            stems: ['рэп', 'реп', 'rap', 'rusrap', 'foreignrap', 'gangsta', 'rapcore', 'battlerap',
                'трэп', 'trap', 'дрилл', 'drill', 'грайм', 'grime']
        },
        {
            id: 'хип-хоп', label: 'Хип-хоп',
            stems: ['хипхоп', 'hiphop', 'хип', 'hip', 'баттл', 'phonk']
        },
        {
            id: 'классика', label: 'Классика',
            stems: ['классик', 'classical', 'классическ', 'симфони', 'symphon', 'оркестр',
                'orchestra', 'опер', 'opera', 'камерн', 'chamber', 'барокко', 'baroque',
                'неоклассик', 'neoclassical', 'сонат', 'соната', 'сюит']
        },
        {
            id: 'шансон', label: 'Шансон',
            stems: ['шансон', 'chanson', 'shanson', 'блатн', 'блат']
        },
        {
            id: 'фолк', label: 'Фолк',
            stems: ['фолк', 'folk', 'этно', 'ethno', 'народн', 'кельт', 'celtic', 'скандинавск',
                'nordic', 'этник', 'ethnic', 'bard', 'польк', 'polka', 'afric', 'африк']
        },
        {
            id: 'регги', label: 'Регги',
            stems: ['регги', 'reggae', 'ска', 'ska', 'даб', 'dub', 'рокстеди', 'rocksteady']
        },
        {
            id: 'кантри', label: 'Кантри',
            stems: ['кантри', 'country', 'вестерн', 'western', 'блюграсс', 'bluegrass']
        },
        {
            id: 'rnb', label: 'R&B / соул',
            stems: ['рнб', 'rnb', 'соул', 'soul', 'фанк', 'funk', 'неосоул', 'neosoul', 'моутаун']
        },
        {
            id: 'саундтрек', label: 'Саундтрек',
            stems: ['саундтрек', 'soundtrack', 'ost', 'score', 'киномузык',
                'film', 'bollywood', 'animated', 'animation', 'anime']
        },
        {
            id: 'эмбиент', label: 'Эмбиент',
            stems: ['эмбиент', 'ambient', 'лоуфай', 'lofi', 'lowfi', 'лоу', 'фай', 'чилл', 'chill',
                'релакс', 'relax', 'медитатив', 'meditative', 'newage']
        },
        // поп — последним: всё, что не опознано как более узкий жанр
        {
            id: 'поп', label: 'Поп',
            stems: ['поп', 'pop', 'попсов', 'эстрад', 'estrada', 'диско', 'disco',
                'евродэнс', 'eurodance', 'данс', 'dance', 'хит',
                'ruspop', 'europop', 'hyperpop', 'turkishpop', 'jpop', 'kpop', 'newwave']
        }
    ];

    const BY_ID = new Map(GENRES.map(g => [g.id, g]));

    // ── теги ID3: старые файлы хранят номер жанра вместо названия ──
    const ID3_GENRES = (
        'Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|' +
        'Other|Pop|R&B|Rap|Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|' +
        'Soundtrack|Euro-Techno|Ambient|Trip-Hop|Vocal|Jazz+Funk|Fusion|Trance|Classical|' +
        'Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|AlternRock|Bass|Soul|Punk|Space|' +
        'Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|Techno-Industrial|' +
        'Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|' +
        'Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychadelic|Rave|' +
        'Showtunes|Trailer|Lo-Fi|Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|' +
        'Hard Rock|Folk|Folk-Rock|National Folk|Swing|Fast Fusion|Bebob|Latin|Revival|Celtic|' +
        'Bluegrass|Avantgarde|Gothic Rock|Progressive Rock|Psychedelic Rock|Symphonic Rock|' +
        'Slow Rock|Big Band|Chorus|Easy Listening|Acoustic|Humour|Speech|Chanson|Opera|' +
        'Chamber Music|Sonata|Symphony|Booty Bass|Primus|Porn Groove|Satire|Slow Jam|Club|' +
        'Tango|Samba|Folklore|Ballad|Power Ballad|Rhythmic Soul|Freestyle|Duet|Punk Rock|' +
        'Drum Solo|A capella|Euro-House|Dance Hall|Goa|Drum & Bass|Club-House|Hardcore|Terror|' +
        'Indie|BritPop|Negerpunk|Polsk Punk|Beat|Christian Gangsta Rap|Heavy Metal|Black Metal|' +
        'Crossover|Contemporary Christian|Christian Rock|Merengue|Salsa|Thrash Metal|Anime|' +
        'JPop|Synthpop'
    ).split('|');

    // что в теге — не жанр, а мусор
    const NOISE_TAGS = new Set([
        'other', 'unknown', 'misc', 'none', 'без жанра', 'нет', 'speech', 'humour', 'comedy',
        'prank', 'pranks', 'game', 'sound clip', 'trailer', 'duet', 'live', 'bootleg', 'cover',
        'vocal', 'chorus', 'noise', 'top 40', 'retro', 'cult', 'dream'
    ]);

    // ── жанры по исполнителю: страховка, когда нет ни тегов, ни папок ──
    // ключи — в нормализованном виде (нижний регистр, ё → е)
    const ARTIST_GENRES = {
        // русский рок
        'кино': 'рок', 'виктор цой': 'рок', 'цой': 'рок', 'наутилус помпилиус': 'рок',
        'вячеслав бутусов': 'рок', 'сплин': 'рок', 'мумий тролль': 'рок', 'би-2': 'рок',
        'агата кристи': 'рок', 'алиса': 'рок', 'ддт': 'рок', 'чайф': 'рок', 'пикник': 'рок',
        'король и шут': 'рок', 'люмен': 'рок', 'звери': 'рок', '7б': 'рок',
        'смысловые галлюцинации': 'рок', 'наив': 'рок', 'порнофильмы': 'рок',
        'кипелов': 'металл', 'ария': 'металл', 'эпидемия': 'металл',
        // зарубежный рок и металл
        'queen': 'рок', 'the beatles': 'рок', 'beatles': 'рок', 'nirvana': 'рок',
        'pink floyd': 'рок', 'led zeppelin': 'рок', 'ac dc': 'рок', 'guns n roses': 'рок',
        'radiohead': 'рок', 'coldplay': 'рок', 'linkin park': 'рок', 'red hot chili peppers': 'рок',
        'u2': 'рок', 'the rolling stones': 'рок', 'rolling stones': 'рок', 'oasis': 'рок',
        'green day': 'рок', 'blink 182': 'рок', 'foo fighters': 'рок', 'muse': 'рок',
        'arctic monkeys': 'рок', 'placebo': 'рок', 'the cranberries': 'рок', 'scorpions': 'рок',
        'bon jovi': 'рок', 'aerosmith': 'рок', 'the killers': 'рок', 'sex pistols': 'рок',
        'the clash': 'рок', 'sum 41': 'рок',
        'metallica': 'металл', 'iron maiden': 'металл', 'black sabbath': 'металл',
        'slayer': 'металл', 'pantera': 'металл', 'rammstein': 'металл', 'slipknot': 'металл',
        'system of a down': 'металл', 'tool': 'металл', 'opeth': 'металл',
        'nightwish': 'металл', 'within temptation': 'металл', 'children of bodom': 'металл',
        // русская поп-сцена
        'полина гагарина': 'поп', 'дима билан': 'поп', 'сергей лазарев': 'поп', 'нюша': 'поп',
        'елка': 'поп', 'светлана лобода': 'поп', 'лобода': 'поп', 'вера брежнева': 'поп',
        'ани лорак': 'поп', 'филипп киркоров': 'поп', 'николай басков': 'поп',
        'валерий меладзе': 'поп', 'винтаж': 'поп', 'руки вверх': 'поп', 'иванушки': 'поп',
        'ольга бузова': 'поп', 'максим': 'поп', 'zivert': 'поп', 'мари краймбрери': 'поп',
        'артур пирожков': 'поп', 'дискотека авария': 'поп',
        // зарубежная поп-сцена
        'michael jackson': 'поп', 'madonna': 'поп', 'britney spears': 'поп', 'lady gaga': 'поп',
        'rihanna': 'поп', 'taylor swift': 'поп', 'adele': 'поп', 'ed sheeran': 'поп',
        'dua lipa': 'поп', 'billie eilish': 'поп', 'ariana grande': 'поп', 'justin bieber': 'поп',
        'katy perry': 'поп', 'bruno mars': 'поп', 'shakira': 'поп', 'abba': 'поп',
        'the weeknd': 'rnb', 'beyonce': 'rnb', 'usher': 'rnb', 'chris brown': 'rnb',
        'alicia keys': 'rnb', 'john legend': 'rnb', 'stevie wonder': 'rnb',
        'marvin gaye': 'rnb', 'aretha franklin': 'rnb', 'james brown': 'rnb', 'prince': 'rnb',
        // рэп
        'eminem': 'рэп', '2pac': 'рэп', 'snoop dogg': 'рэп', 'drake': 'рэп',
        'kendrick lamar': 'рэп', 'kanye west': 'рэп', 'jay z': 'рэп',
        '50 cent': 'рэп', 'nas': 'рэп', 'lil wayne': 'рэп',
        'баста': 'рэп', 'оксимирон': 'рэп', 'oxxxymiron': 'рэп',
        'скриптонит': 'рэп', 'тимати': 'рэп', 'элджей': 'рэп',
        'мияги': 'рэп', 'miya gi': 'рэп', 'моргенштерн': 'рэп',
        'morgenshtern': 'рэп', 'kizaru': 'рэп', 'big baby tape': 'рэп',
        // джаз и блюз
        'louis armstrong': 'джаз', 'луи армстронг': 'джаз', 'ella fitzgerald': 'джаз',
        'miles davis': 'джаз', 'john coltrane': 'джаз', 'bill evans': 'джаз',
        'chet baker': 'джаз', 'diana krall': 'джаз', 'norah jones': 'джаз',
        'ray charles': 'джаз', 'bb king': 'блюз', 'muddy waters': 'блюз',
        'robert johnson': 'блюз', 'gary moore': 'блюз',
        // электроника
        'daft punk': 'электроника', 'the prodigy': 'электроника', 'prodigy': 'электроника',
        'aphex twin': 'электроника', 'deadmau5': 'электроника', 'calvin harris': 'электроника',
        'david guetta': 'электроника', 'avicii': 'электроника', 'martin garrix': 'электроника',
        'zedd': 'электроника', 'skrillex': 'электроника', 'tiesto': 'электроника',
        'armin van buuren': 'электроника', 'hardwell': 'электроника',
        // классика
        'bach': 'классика', 'бах': 'классика', 'mozart': 'классика', 'моцарт': 'классика',
        'beethoven': 'классика', 'бетховен': 'классика', 'чайковский': 'классика',
        'tchaikovsky': 'классика', 'rachmaninoff': 'классика', 'рахманинов': 'классика',
        'chopin': 'классика', 'шопен': 'классика', 'vivaldi': 'классика', 'вивальди': 'классика',
        'debussy': 'классика', 'дебюсси': 'классика', 'прокофьев': 'классика',
        'shostakovich': 'классика', 'глинка': 'классика', 'ludovico einaudi': 'классика',
        // шансон
        'михаил круг': 'шансон', 'сергей трофимов': 'шансон', 'иван кучин': 'шансон',
        'гарик кричевский': 'шансон', 'бутырка': 'шансон', 'лесоповал': 'шансон',
        'воровайки': 'шансон', 'михаил шуфутинский': 'шансон', 'шуфутинский': 'шансон',
        'рада рай': 'шансон', 'стас михайлов': 'шансон',
        // фолк
        'мельница': 'фолк', 'хелависа': 'фолк', 'пелагея': 'фолк', 'иван купала': 'фолк',
        'wardruna': 'фолк', 'enya': 'фолк', 'blackmore s night': 'фолк',
        // регги, кантри, саундтреки
        'bob marley': 'регги', 'боб марли': 'регги', 'damian marley': 'регги', 'shaggy': 'регги',
        'johnny cash': 'кантри', 'dolly parton': 'кантри', 'willie nelson': 'кантри',
        'kenny rogers': 'кантри', 'shania twain': 'кантри',
        'hans zimmer': 'саундтрек', 'john williams': 'саундтрек', 'ennio morricone': 'саундтрек',
        'ramin djawadi': 'саундтрек', 'howard shore': 'саундтрек',
        // эмбиент
        'brian eno': 'эмбиент', 'nils frahm': 'эмбиент'
    };

    // ──────────────────────────────────────────────────────────────
    //  нормализация и сравнение основ
    // ──────────────────────────────────────────────────────────────
    function norm(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .replace(/ё/g, 'е')
            // «R&B» — это один жанр, а не две буквы
            .replace(/r\s*&\s*b/g, 'rnb')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
    }

    function tokenize(s) {
        const n = norm(s);
        return n ? n.split(' ') : [];
    }

    // Слова с сохранением дефисов: «рок-н-ролл» — одно слово, и если
    // внутри нашёлся жанр, то слово считается разобранным целиком.
    // joined — то же слово без разделителей: «Trip-Hop» → «triphop».
    function words(s) {
        const n = String(s == null ? '' : s)
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/r\s*&\s*b/g, 'rnb');
        return n.split(/\s+/).filter(Boolean).map(w => {
            const parts = w.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
            return { raw: w, parts, joined: parts.join('') };
        });
    }

    function wordHitsGenre(w, g) {
        if (w.parts.some(t => g.stems.some(s => tokenMatches(t, s)))) return true;
        // составное через дефис: Trip-Hop, Drum-and-Bass
        return w.parts.length > 1 && g.stems.some(s => tokenMatches(w.joined, s));
    }

    // «рок» → «рока/року/роком», «джаз» → «джазовое», но «рок» ≠ «рококо».
    // Латиница — отдельная история: составные жанры в тегах пишут слитно
    // (Rusrap, Numetal, Hyperpopgenre), поэтому там ищем и внутри слова.
    function tokenMatches(token, stem) {
        if (!token || !stem) return false;
        if (token === stem) return true;

        const latin = /^[a-z0-9]+$/.test(token) && /^[a-z0-9]+$/.test(stem);
        if (latin) {
            // трёхбуквенные (ost, pop, rap, ska) — только целиком,
            // иначе «ost» цепляется за «ostrov», а «ska» — за «alaska»
            if (stem.length <= 3) return false;
            return token.startsWith(stem) || token.includes(stem);
        }

        if (!token.startsWith(stem)) return false;
        const extra = token.length - stem.length;
        if (stem.length >= 5) return extra <= 4;
        if (stem.length === 4) return extra <= 3;
        return extra <= 2;
    }

    // ──────────────────────────────────────────────────────────────
    //  публичный API
    // ──────────────────────────────────────────────────────────────

    // все жанры, которые упомянуты в тексте (в порядке приоритета)
    function detect(text) {
        const list = words(text);
        if (!list.length) return [];
        const out = [];
        for (const g of GENRES) {
            if (list.some(w => wordHitsGenre(w, g))) out.push(g.id);
        }
        return out;
    }

    // какие слова съел жанр, а что осталось («рок-группа кино» → остаток «кино»)
    function consume(text) {
        const list = words(text);
        const used = new Set();
        const ids = [];
        list.forEach((w, i) => {
            for (const g of GENRES) {
                if (!wordHitsGenre(w, g)) continue;
                used.add(i);
                if (!ids.includes(g.id)) ids.push(g.id);
            }
        });
        return {
            ids,
            tokens: list.flatMap(w => w.parts),
            rest: list.filter((_, i) => !used.has(i)).map(w => w.raw)
        };
    }

    // жанр из пути к файлу: имя файла не смотрим, только папки
    function detectFolder(path) {
        const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
        if (parts.length > 1) parts.pop();
        if (!parts.length) return [];
        return detect(parts.join(' '));
    }

    // жанр по исполнителю: сначала точное совпадение, потом самое длинное вхождение
    function detectArtist(name) {
        const key = norm(name);
        if (!key) return null;
        if (ARTIST_GENRES[key]) return ARTIST_GENRES[key];

        let best = null;
        let bestLen = 0;
        for (const k in ARTIST_GENRES) {
            if (k.length <= bestLen) continue;
            const at = (' ' + key + ' ').indexOf(' ' + k + ' ');
            if (at === -1) continue;
            best = ARTIST_GENRES[k];
            bestLen = k.length;
        }
        if (best) return best;

        // «Полины Гагариной» — сравниваем основы слов
        const nameTokens = tokenize(name);
        for (const k in ARTIST_GENRES) {
            const kTokens = tokenize(k);
            if (!kTokens.length || kTokens.length > nameTokens.length) continue;
            const hit = kTokens.every(kt => nameTokens.some(nt => tokenMatches(nt, kt.slice(0, Math.min(kt.length, 5)))));
            if (hit && k.length > bestLen) {
                best = ARTIST_GENRES[k];
                bestLen = k.length;
            }
        }
        return best;
    }

    // жанр из тега ID3: строка, номер («17») или «(17)Rock»
    function fromTag(raw) {
        if (raw == null) return [];
        let name = String(raw).trim();
        if (!name) return [];

        const num = name.match(/^\(?(\d{1,3})\)?$/);
        if (num) name = ID3_GENRES[Number(num[1])] || '';

        name = name.replace(/\(\s*\d{1,3}\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
        if (!name) return [];

        const ids = detect(name);
        if (ids.length) return ids;
        if (NOISE_TAGS.has(norm(name))) return [];

        // жанр есть, но в справочнике его нет — показываем как есть
        return [name.slice(0, 24)];
    }

    function label(id) {
        const g = BY_ID.get(String(id || '').toLowerCase());
        if (g) return g.label;
        const s = String(id || '');
        return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
    }

    function isKnown(id) {
        return BY_ID.has(String(id || '').toLowerCase());
    }

    // короткое имя жанра для озвучки: «R&B / соул» → «ритм-н-блюз»
    function sayable(id) {
        if (id === 'rnb') return 'ритм-н-блюз';
        return label(id);
    }

    global.KivoGenres = {
        version: 1,
        genres: GENRES.map(g => ({ id: g.id, label: g.label })),
        detect,
        consume,
        detectFolder,
        detectArtist,
        fromTag,
        label,
        sayable,
        isKnown,
        norm,
        tokenMatches
    };
})(typeof window !== 'undefined' ? window : globalThis);
