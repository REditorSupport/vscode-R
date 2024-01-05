
import * as cheerio from 'cheerio';
import { Package} from './packages';
import fetch from 'node-fetch';

type ParseFunction = (html: string, baseUrl: string) => Package[];

export async function getPackagesFromCran(cranUrl: string): Promise<Package[]> {
    const cranSites: {url: string, parseFunction: ParseFunction}[] = [
        // NOTE: Not working any more
        // {
        //     url: new URL('stats/descriptions', cranUrl).toString(),
        //     parseFunction: parseCranJson
        // },
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
            if (rowIndex === 0) {return;} // Skip the header row
            const date = $(row).find('td:nth-child(1)').text().trim();
            const href = $(row).find('td:nth-child(2) a').attr('href');
            const url = href ? new URL(href, baseUrl).toString() : undefined;
            const name = $(row).find('td:nth-child(2) span').text().trim();
            const title = $(row).find('td:nth-child(3)').text().trim();
            ret.push({
                date: date,
                name: name,
                href: url,
                description: title,
                isCran: true
            });
        });
    });

    const retSorted = ret.sort((a, b) => a.name.localeCompare(b.name));

    return retSorted;
}
