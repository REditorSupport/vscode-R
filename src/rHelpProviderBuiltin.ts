


import * as cp from 'child_process';

import * as http from 'http';

import * as rHelpPanel from './rHelpPanel';

const kill = require('tree-kill');

export interface RHelpClientOptions extends rHelpPanel.RHelpProviderOptions {
	// path of the R executable
    rPath: string;
}


// Class to forward help requests to a backgorund R instance that is running a help server
export class RHelpClient implements rHelpPanel.HelpProvider {
    private cp: cp.ChildProcess;
    private port: number|Promise<number>;
    private readonly rPath: string;
    private readonly cwd?: string;

    public constructor(options: RHelpClientOptions){
        this.rPath = options.rPath || 'R';
        this.cwd = options.cwd;
        this.port = this.launchRHelpServer(); // is a promise for now!
    }

    public refresh(){
        kill(this.cp.pid); // more reliable than cp.kill (?)
        this.port = this.launchRHelpServer();
    }

    public async launchRHelpServer(){
		const lim = '---vsc---';
		const re = new RegExp(`.*${lim}(.*)${lim}.*`, 'ms');

        // starts the background help server and waits forever to keep the R process running
        const cmd = (
            `${this.rPath} --silent --slave --no-save --no-restore -e ` +
            `"cat('${lim}', tools::startDynamicHelp(), '${lim}', sep=''); while(TRUE) Sys.sleep(1)" ` 
        );
        const cpOptions = {
            cwd: this.cwd
        };
        this.cp = cp.exec(cmd, cpOptions);

        let str = '';
        // promise containing the first output of the r process (contains only the port number)
        const outputPromise = new Promise<string>((resolve, reject) => {
            this.cp.stdout.on('data', (data) => {
                str += data.toString();
                if(str.match(re)){
                    resolve(str.replace(re, '$1'));
                }
            });
            this.cp.on('close', (code) => {
                console.log('R process closed with code ' + code);
                reject();
            });
        });

        // await and store port number
        const output = await outputPromise;
        const port = Number(output);

        // is returned as a promise if not called with "await":
        return port;
    }

	public async getHelpFileFromRequestPath(requestPath: string): Promise<null|rHelpPanel.HelpFile> {
        // make sure the server is actually running
        this.port = await this.port;

        if(!this.port || typeof this.port !== 'number'){
            return null;
        }

        // remove leading '/'
        while(requestPath.startsWith('/')){
            requestPath = requestPath.substr(1);
        }

        interface HtmlResult {
            content?: string,
            redirect?: string
        }
    
        // forward request to R instance
        // below is just a complicated way of getting a http response from the help server
        let url = `http://localhost:${this.port}/${requestPath}`;
        let html = '';
        const maxForwards = 3;
        for (let index = 0; index < maxForwards; index++) {
            const htmlPromise = new Promise<HtmlResult>((resolve, reject) => {
                let content: string = '';
                http.get(url, (res: http.IncomingMessage) => {
                    if(res.statusCode === 302){
                        resolve({redirect: res.headers.location});
                    }
                    res.on('data', (chunk) => {
                        content += chunk.toString();
                    });
                    res.on('close', () => {
                        resolve({content: content});
                    });
                    res.on('error', () => {
                        reject();
                    });
                });
            });
            const htmlResult = await htmlPromise;
            if(htmlResult.redirect){
                const newUrl = new URL(htmlResult.redirect, url);
                requestPath = newUrl.pathname;
                url = newUrl.toString();
            } else{
                html = htmlResult.content || '';
                break;
            }
        }

        // return help file
        const ret: rHelpPanel.HelpFile = {
            requestPath: requestPath,
            html: html,
            isRealFile: false
        };
        return ret;
    }

    dispose(){
        if(this.cp){
            this.cp.kill();
        }
    }
}


