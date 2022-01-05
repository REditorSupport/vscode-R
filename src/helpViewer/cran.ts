
import * as cheerio from 'cheerio';
import { Package} from './packages';
import fetch from 'node-fetch';

type ParseFunction = (html: string, baseUrl: string) => Package[];

export async function getPackagesFromCran(cranUrl: string): Promise<Package[]> {
    const cranSites: {url: string, parseFunction: ParseFunction}[] = [
        {
            url: new URL('stats/descriptions', cranUrl).toString(),
            parseFunction: parseCranJson
        },
        {
            url: new URL('web/packages/available_packages_by_date.html', cranUrl).toString(),
            parseFunction: parseCranTable
        },
        {
            url: new URL('src/contrib/PACKAGES', cranUrl).toString(),
            parseFunction: parseCranPackagesFile
        }
    ];
    let packages: Package[] = [];
    for(const site of cranSites){
        try{
            // fetch html
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // seems to fail otherwise?
            const res = await fetch(site.url);
            const html = await (res).text();

            // parse html
            packages = site.parseFunction(html, site.url);
        } catch(e) {
            // These errors are expected, if the repo does not serve a specific URL
        } finally {
            // make sure to use safe https again
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
        }

        // break if successfully fetched & parsed
        if(packages?.length){
            break;
        }
    }
    return packages;
}

function parseCranPackagesFile(html: string): Package[] {
    const packageNames = html.match(/^Package: .*$/gm)?.map(s => s.replace(/^Package: /, '')) || [];
    const packages: Package[] = packageNames.map(s => ({
        name: s,
        description: '',
        isCran: true
    }));
    return packages;
}

function parseCranJson(jsonString: string): Package[] {
    const lines = jsonString.split('\n').filter(v => v);
    const pkgs = lines.map(line => {
        const j = JSON.parse(line) as {[key: string]: string};
        const pkg: Package = {
            name: j['Package'],
            description: j['Title'],
            date: j['modified'],
            isCran: true
        };
        return pkg;
    });
    return pkgs;
}

function parseCranTable(html: string, baseUrl: string): Package[] {
    if(!html){
        return [];
    }
    const $ = cheerio.load(html);
    const tables = $('table');
    const ret: Package[] = [];

    // loop over all tables on document and each row as one index entry
    // assumes that the provided html is from a valid index file
    tables.each((tableIndex, table) => {
        const rows = $('tr', table);
        rows.each((rowIndex, row) => {
            const elements = $('td', row);
            if(elements.length === 3){

                const e0 = elements[0];
                const e1 = elements[1];
                const e2 = elements[2];
                if(
                    e0.type === 'tag' && e1.type === 'tag' &&
                    e0.firstChild?.type === 'text' && e1.children[1].type === 'tag' &&
                    e2.type === 'tag'
                ){
                    const href = e1.children[1].attribs['href'];
                    const url = new URL(href, baseUrl).toString();
                    ret.push({
                        date: (e0.firstChild.data || '').trim(),
                        name: (e1.children[1].firstChild?.data || '').trim(),
                        href: url,
                        description: (e2.firstChild?.data || '').trim(),
                        isCran: true
                    });
                }
            }
        });
    });

    const retSorted = ret.sort((a, b) => a.name.localeCompare(b.name));

    return retSorted;
}



