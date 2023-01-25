import * as NewIngestion from './newingestion.js';
import { AzureLabels } from './newingestion.js';
import { setSchema } from './utils.js';
import fs from 'fs';
import readline from 'readline';
import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { streamArray } from 'stream-json/streamers/StreamArray';
const { batch } = require('stream-json/utils/Batch');
const neo4j = require('neo4j-driver');

const conn_uri = process.env['NEOURL'] == null ? 'bolt://localhost:7687' : process.env['NEOURL']
const username = process.env['NEOUSER'] == null ? 'neo4j' : process.env['NEOUSER']
if (process.env['NEOPWD'] == null || process.env['NEOPWD'].length == 0) {
    console.log("Missing environment variable NEOPWD");
    process.exit(1)
}

global.driver = neo4j.driver(conn_uri, neo4j.auth.basic(username, process.env['NEOPWD']));
// emitter is used in utils.js, mocking it here so the code can be imported without change
global.emitter = {'emit': function (_) {}};
// used by post-processing
const incrementPostProcessStep = function () {};
// batch size used by Azure post-processing
const batchSize = 1000;

// prototype functions from BloodHound/src/index.js required in newingestion.js
String.prototype.format = function () {
    let i = 0;
    const args = arguments;
    return this.replace(/{}/g, function () {
        return typeof args[i] !== 'undefined' ? args[i++] : '';
    });
};

String.prototype.formatn = function () {
    let formatted = this;
    for (let i = 0; i < arguments.length; i++) {
        const regexp = new RegExp('\\{' + i + '\\}', 'gi');
        formatted = formatted.replace(regexp, arguments[i]);
    }
    return formatted;
};

Array.prototype.chunk = function (chunkSize = 10000) {
    let i;
    let len = this.length;
    let temp = [];

    for (i = 0; i < len; i += chunkSize) {
        temp.push(this.slice(i, i + chunkSize));
    }

    return temp;
};
// end of prototype functions from BloodHound/src/index.js required in newingestion.js

// file validation & import logic from BloodHound/src/components/Menu/MenuContainer.jsx
const IngestFuncMap = {
    computers: NewIngestion.buildComputerJsonNew,
    groups: NewIngestion.buildGroupJsonNew,
    users: NewIngestion.buildUserJsonNew,
    domains: NewIngestion.buildDomainJsonNew,
    ous: NewIngestion.buildOuJsonNew,
    gpos: NewIngestion.buildGpoJsonNew,
    containers: NewIngestion.buildContainerJsonNew,
    azure: NewIngestion.convertAzureData,
};

const uploadData = async (statement, props) => {
    let session = driver.session();
    await session.run(statement, { props: props }).catch((err) => {
        console.log(statement);
        console.log(err);
    });
    await session.close();
};

const checkFileValidity = async (file) => {
    let meta = await getMetaTagQuick(file);

    if (!('version' in meta) || meta.version < 4) {
        console.log('Missing version or wrong version in meta')
        return null;
    }

    if (!Object.keys(IngestFuncMap).includes(meta.type)) {
        console.log('Invalid meta type: '  +meta.type);
        return null;
    }

    return {...file,
        count: meta.count,
        type: meta.type,
    };
};

const getMetaTagQuick = async (file) => {
    let size = fs.statSync(file.path).size;
    let start = size - 300;
    if (start <= 0) {
        start = 0;
    }
    //Try end of file first
    let prom = new Promise((resolve, reject) => {
        fs.createReadStream(file.path, {
            encoding: 'utf8',
            start: start,
            end: size,
        }).on('data', (chunk) => {
            let type, version, count;
            try {
                let search = [...chunk.matchAll(/"type.?:\s?"(\w*)"/g)];
                type = search[search.length - 1][1];
                search = [...chunk.matchAll(/"count.?:\s?(\d*)/g)];
                count = parseInt(search[search.length - 1][1]);
            } catch (e) {
                type = null;
                count = null;
            }
            try {
                let search = [...chunk.matchAll(/"version.?:\s?(\d*)/g)];
                    version = parseInt(search[search.length - 1][1]);
                } catch (e) {
                    version = null;
                }

            resolve({
                count: count,
                type: type,
                version: version,
            });
        });
      });

    let meta = await prom;
    if (meta.type !== null && meta.count !== null) {
        return meta;
    }
    //Try the beginning of the file next
    prom = new Promise((resolve, reject) => {
        fs.createReadStream(file.path, {
            encoding: 'utf8',
            start: 0,
            end: 300,
        }).on('data', (chunk) => {
            let type, version, count;
            try {
                type = /type.?:\s+"(\w*)"/g.exec(chunk)[1];
                count = parseInt(/count.?:\s+(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                type = null;
                count = null;
            }
            try {
                version = parseInt(/version.?:\s+(\d*)/g.exec(chunk)[1]);
            } catch (e) {
                version = null;
            }

            resolve({
                count: count,
                type: type,
                version: version,
            });
        });
    });

    meta = await prom;
    return meta;
};

const processJson = async (file) => {
    console.log(`Processing ${file.path} with ${file.count} ${file.type} entries`);

    const pipeline = chain([
        fs.createReadStream(file.path, { encoding: 'utf8' }),
        parser(),
        pick({ filter: 'data' }),
        streamArray(),
        (data) => data.value,
        batch({ batchSize: 200 }),
    ]);

    let count = 0;
    let processor = IngestFuncMap[file.type];

    pipeline.on('data', async (data) => {
        try {
            pipeline.pause();
            count += data.length;
            readline.clearLine(process.stdout);
            readline.cursorTo(process.stdout, 0);
            process.stdout.write(`Processed ${count}`)

            let processedData = processor(data);

            if (file.type === 'azure') {
                for (let value of Object.values(
                    processedData.AzurePropertyMaps
                )) {
                    let props = value.Props;
                    if (props.length === 0) continue;
                    let chunked = props.chunk();
                    let statement = value.Statement;

                    for (let chunk of chunked) {
                        await uploadData(statement, chunk);
                    }
                }

                for (let item of Object.values(
                    processedData.OnPremPropertyMaps
                )) {
                    let props = item.Props;
                    if (props.length === 0) continue;
                    let chunked = props.chunk();
                    let statement = item.Statement;

                    for (let chunk of chunked) {
                        await uploadData(statement, chunk);
                    }
                }

                for (let item of Object.values(
                    processedData.RelPropertyMaps
                )) {
                    let props = item.Props;
                    if (props.length === 0) continue;
                    let chunked = props.chunk();
                    let statement = item.Statement;

                    for (let chunk of chunked) {
                        await uploadData(statement, chunk);
                    }
                }
            } else {
                for (let key in processedData) {
                    let props = processedData[key].props;
                    if (props.length === 0) continue;
                    let chunked = props.chunk();
                    let statement = processedData[key].statement;

                    for (let chunk of chunked) {
                        await uploadData(statement, chunk);
                    }
                }
            }

            pipeline.resume();
        } catch (e) {
            console.error(e);
            throw e;
        }

        return null;
    });

    return new Promise((resolve, reject) => {
        pipeline.on('end', () => resolve("just some value to return"))
        pipeline.on('error', () => reject);
    });
};
// end of file validation & import logic from BloodHound/src/components/Menu/MenuContainer.jsx

// post-import steps from BloodHound/src/components/Menu/MenuContainer.jsx copied without modification
//    postGetChanges
//    ADPostProcessSteps
//    AzurePostProcessSteps
//    executePostProcessSteps

const postGetChanges = async (session) => {
    await session
        .run('MATCH (n:Domain) RETURN n.objectid AS domainid')
        .catch((err) => {
            console.log(err);
        })
        .then(async (res) => {
            for (let domain of res.records) {
                let domainId = domain.get('domainid');

                let getChangesResult = await session.run(
                    'MATCH (n)-[:MemberOf|GetChanges*1..]->(:Domain {objectid: $objectid}) RETURN n',
                    { objectid: domainId }
                );
                let getChangesPrincipals = [];
                for (let principal of getChangesResult.records) {
                    getChangesPrincipals.push(
                        principal.get('n').properties.objectid
                    );
                }

                let getChangesAllResult = await session.run(
                    'MATCH (n)-[:MemberOf|GetChangesAll*1..]->(:Domain {objectid: $objectid}) RETURN n',
                    { objectid: domainId }
                );
                let getChangesAllPrincipals = [];
                for (let principal of getChangesAllResult.records) {
                    getChangesAllPrincipals.push(
                        principal.get('n').properties.objectid
                    );
                }

                let getChangesFilteredResult = await session.run(
                    'MATCH (n)-[:MemberOf|GetChangesInFilteredSet*1..]->(:Domain {objectid: $objectid}) RETURN n',
                    { objectid: domainId }
                );
                let getChangesFilteredSetPrincipals = [];
                for (let principal of getChangesFilteredResult.records) {
                    getChangesFilteredSetPrincipals.push(
                        principal.get('n').properties.objectid
                    );
                }

                let dcSyncPrincipals = getChangesPrincipals.filter(
                    (principal) =>
                        getChangesAllPrincipals.includes(principal)
                );

                if (dcSyncPrincipals.length > 0) {
                    console.log(
                        'Found DC Sync principals: ' +
                            dcSyncPrincipals.join(', ') +
                            ' in domain ' +
                            domainId
                    );
                    await session.run(
                        'UNWIND $syncers AS sync MATCH (n:Base {objectid: sync}) MATCH (m:Domain {objectid: $domainid}) MERGE (n)-[:DCSync {isacl: true, isinherited: false}]->(m)',
                        {
                            syncers: dcSyncPrincipals,
                            domainid: domainId,
                        }
                    );
                }

                let syncsLapsPrincipals = getChangesPrincipals.filter(
                    (principal) =>
                        getChangesFilteredSetPrincipals.includes(principal)
                );
                if (syncsLapsPrincipals.length > 0) {
                    console.log(
                        'Found SyncLAPSPassword principals: ' +
                            syncsLapsPrincipals.join(', ') +
                            ' in domain ' +
                            domainId
                    );
                    await session.run(
                        `UNWIND $syncers AS sync MATCH (n:Base {objectid: sync}) MATCH (m:Computer {domainsid: $domainid, haslaps:true})
                            CALL {
                                WITH n, m
                                MERGE (n)-[:SyncLAPSPassword {isacl: true, isinherited: false}]->(m)
                            } IN TRANSACTIONS OF 500 ROWS`,
                        {
                            syncers: syncsLapsPrincipals,
                            domainid: domainId,
                        }
                    );
                }
            }
        });
};

const ADPostProcessSteps = [
    {
        step: 'baseOwned',
        type: 'query',
        statement:
            'MATCH (n) WHERE n:User or n:Computer AND NOT EXISTS(n.owned) CALL {WITH n SET n.owned = false} IN TRANSACTIONS OF 500 ROWS',
        params: null,
    },
    {
        step: 'baseHighValue',
        type: 'query',
        statement:
            'MATCH (n:Base) WHERE NOT EXISTS(n.highvalue) CALL { WITH n SET n.highvalue = false} IN TRANSACTIONS OF 500 ROWS',
        params: null,
    },
    {
        step: 'domainUserAssociation',
        type: 'query',
        statement:
            "MATCH (n:Group) WHERE n.objectid ENDS WITH '-513' OR n.objectid ENDS WITH '-515' WITH n UNWIND $sids AS sid MATCH (m:Group) WHERE m.objectid ENDS WITH sid MERGE (n)-[:MemberOf]->(m)",
        params: { sids: ['S-1-1-0', 'S-1-5-11'] }, //domain user sids
    },
    {
        step: 'postDCSync',
        type: 'callback',
        callback: postGetChanges,
    },
];
const AzurePostProcessSteps = [
    {
        step: 'setTenantsHighValue',
        description: 'Mark all tenants as High Value',
        type: 'query',
        statement: 'MATCH (n:AZTenant) SET n.highvalue=TRUE',
        params: null,
    },
    {
        step: 'setGlobalAdminHighValue',
        description: 'Mark all global admins as High Value',
        type: 'query',
        statement: `MATCH (n:AZRole {templateid:"62E90394-69F5-4237-9190-012177145E10"})
            OPTIONAL MATCH (g:AZGroup)-[:AZHasRole]->(n)
            OPTIONAL MATCH (i)-[:AZMemberOf]->(g) WHERE n:AZUser OR n:AZServicePrincipal OR n:AZDevice
            OPTIONAL MATCH (p)-[:AZHasRole]->(n) WHERE n:AZUser OR n:AZServicePrincipal OR n:AZDevice
            CALL {
                WITH g,i,p
                SET g.highvalue=true, i.highvalue=true, p.highvalue=true
            } IN TRANSACTIONS OF 500 ROWS`,
        params: null,
    },
    {
        step: 'setPrivRoleAdminHighValue',
        description: 'Mark all privileged role admins as High Value',
        type: 'query',
        statement: `MATCH (n:AZRole {templateid:"E8611AB8-C189-46E8-94E1-60213AB1F814"})
            OPTIONAL MATCH (g:AZGroup)-[:AZHasRole]->(n)
            OPTIONAL MATCH (i)-[:AZMemberOf]->(g) WHERE n:AZUser OR n:AZServicePrincipal OR n:AZDevice
            OPTIONAL MATCH (p)-[:AZHasRole]->(n) WHERE n:AZUser OR n:AZServicePrincipal OR n:AZDevice
            CALL {
                WITH g,i,p
                SET g.highvalue=true, i.highvalue=true, p.highvalue=true
            } IN TRANSACTIONS OF 500 ROWS`,
        params: null,
    },
    {
        step: 'clearPostProcessesedRels',
        description: 'Blow away all existing post-processed relationships',
        type: 'query',
        statement:
            `MATCH (:AZBase)-[r:{0}]->() CALL { WITH r DELETE r } IN TRANSACTIONS OF {1} ROWS`.formatn(
                [
                    AzureLabels.AddSecret,
                    AzureLabels.ExecuteCommand,
                    AzureLabels.ResetPassword,
                    AzureLabels.AddMembers,
                    AzureLabels.GlobalAdmin,
                    AzureLabels.PrivilegedAuthAdmin,
                    AzureLabels.PrivilegedRoleAdmin,
                ].join('|'),
                batchSize
            ),
        params: null,
        log: (result) =>
            `Deleted ${
                result.summary.counters.updates().relationshipsDeleted
            } post-processed rels`,
    },
    {
        step: 'createAZGlobalAdminEdges',
        description:
            'Global Admins get a direct edge to the AZTenant object they have that role assignment in',
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)<-[:AZContains]-(t:AZTenant)
                    WHERE m.templateid IN ['62E90394-69F5-4237-9190-012177145E10']
                    CALL {
                        WITH n,t
                        MERGE (n)-[:AZGlobalAdmin]->(t)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: null,
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZGlobalAdmin Edges`,
    },
    {
        step: 'createAZPrivilegedRoleAdminEdges',
        description:
            'Privileged Role Admins get a direct edge to the AZTenant object they have that role assignment in',
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)<-[:AZContains]-(t:AZTenant)
                    WHERE m.templateid IN ['E8611AB8-C189-46E8-94E1-60213AB1F814']
                    CALL {
                        WITH n,t
                        MERGE (n)-[:AZPrivilegedRoleAdmin]->(t)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: null,
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZPrivilegedRoleAdmin Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description: 'Any principal with a password reset role can reset the password of other cloud-resident, non-external users in the same tenant, where those users do not have ANY AzureAD admin role assignment',
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $pwResetRoles
                    WITH n
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    WITH at,n
                    MATCH (at)-[:AZContains]->(u:AZUser)
                    WHERE NOT (u)-[:AZHasRole]->()
                    CALL {
                        WITH n, u
                        MERGE (n)-[:AZResetPassword]->(u)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            pwResetRoles: [
                'C4E39BD9-1100-46D3-8C65-FB160DA0071F',
                '62E90394-69F5-4237-9190-012177145E10',
                '729827E3-9C14-49F7-BB1B-9608F156BBB8',
                '966707D0-3269-4727-9BE2-8C3A10F19B9D',
                '7BE44C8A-ADAF-4E2A-84D6-AB2649E08A13',
                'FE930BE7-5E62-47DB-91AF-98C3A49A38B1',
                '9980E02C-C2BE-4D73-94E8-173B1DC7CF3C',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description:
            'Global Admins and Privileged Authentication Admins can reset the password for any user in the same tenant',
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $GAandPAA
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    MATCH (at)-[:AZContains]->(u:AZUser)
                    CALL {
                        WITH n, u
                        MERGE (n)-[:AZResetPassword]->(u)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            GAandPAA: [
                '62E90394-69F5-4237-9190-012177145E10',
                '7BE44C8A-ADAF-4E2A-84D6-AB2649E08A13',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description: `Authentication Admins can reset the password for other users with one or more of the following roles:
    Auth Admins, Helpdesk Admins, Password Admins, Directory Readers, Guest Inviters, Message Center Readers, and Reports Readers
    Authentication admin template id: c4e39bd9-1100-46d3-8c65-fb160da0071f`,
        type: 'query',
        statement:
            `MATCH (at:AZTenant)-[:AZContains]->(AuthAdmin)-[:AZHasRole]->(AuthAdminRole:AZRole {templateid:"C4E39BD9-1100-46D3-8C65-FB160DA0071F"})
            MATCH (NonTargets:AZUser)-[:AZHasRole]->(ar:AZRole)
            WHERE NOT ar.templateid IN $AuthAdminTargetRoles
            WITH COLLECT(NonTargets) AS NonTargets,at,AuthAdmin
            MATCH (at)-[:AZContains]->(AuthAdminTargets:AZUser)-[:AZHasRole]->(arTargets)
            WHERE NOT AuthAdminTargets IN NonTargets AND arTargets.templateid IN $AuthAdminTargetRoles
            CALL {
                WITH AuthAdmin, AuthAdminTargets
                MERGE (AuthAdmin)-[:AZResetPassword]->(AuthAdminTargets)
            } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            AuthAdminTargetRoles: [
                'C4E39BD9-1100-46D3-8C65-FB160DA0071F',
                '88D8E3E3-8F55-4A1E-953A-9B9898B8876B',
                '95E79109-95C0-4D8E-AEE3-D01ACCF2D47B',
                '729827E3-9C14-49F7-BB1B-9608F156BBB8',
                '790C1FB9-7F7D-4F88-86A1-EF1F95C05C1B',
                '4A5D8F65-41DA-4DE4-8968-E035B65339CF',
                '966707D0-3269-4727-9BE2-8C3A10F19B9D',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description: `Helpdesk Admins can reset the password for other users with one or more of the following roles:
    Auth Admin, Directory Readers, Guest Inviter, Helpdesk Administrator, Message Center Reader, Reports Reader
    Helpdesk Admin template id: 729827e3-9c14-49f7-bb1b-9608f156bbb8`,
        type: 'query',
        statement:
            `MATCH (at:AZTenant)-[:AZContains]->(HelpdeskAdmin)-[:AZHasRole]->(HelpdeskAdminRole:AZRole {templateid:"729827E3-9C14-49F7-BB1B-9608F156BBB8"})
            MATCH (NonTargets:AZUser)-[:AZHasRole]->(ar:AZRole)
            WHERE NOT ar.templateid IN $HelpdeskAdminTargetRoles
            WITH COLLECT(NonTargets) AS NonTargets,at,HelpdeskAdmin
            MATCH (at)-[:AZContains]->(HelpdeskAdminTargets:AZUser)-[:AZHasRole]->(arTargets)
            WHERE NOT HelpdeskAdminTargets IN NonTargets AND arTargets.templateid IN $HelpdeskAdminTargetRoles
            CALL {
                WITH HelpdeskAdmin, HelpdeskAdminTargets
                MERGE (HelpdeskAdmin)-[:AZResetPassword]->(HelpdeskAdminTargets)
            } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            HelpdeskAdminTargetRoles: [
                'C4E39BD9-1100-46D3-8C65-FB160DA0071F',
                '88D8E3E3-8F55-4A1E-953A-9B9898B8876B',
                '95E79109-95C0-4D8E-AEE3-D01ACCF2D47B',
                '729827E3-9C14-49F7-BB1B-9608F156BBB8',
                '790C1FB9-7F7D-4F88-86A1-EF1F95C05C1B',
                '4A5D8F65-41DA-4DE4-8968-E035B65339CF',
                '966707D0-3269-4727-9BE2-8C3A10F19B9D',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description: `Password Admins can reset the password for other users with one or more of the following roles: Directory Readers, Guest Inviter, Password Administrator                                                                                                 Password Admin template id: 966707d0-3269-4727-9be2-8c3a10f19b9d`,
        type: 'query',
        statement:
            `MATCH (at:AZTenant)-[:AZContains]->(PasswordAdmin)-[:AZHasRole]->(PasswordAdminRole:AZRole {templateid:"966707D0-3269-4727-9BE2-8C3A10F19B9D"})
            MATCH (NonTargets:AZUser)-[:AZHasRole]->(ar:AZRole)
            WHERE NOT ar.templateid IN $PasswordAdminTargetRoles
            WITH COLLECT(NonTargets) AS NonTargets,at,PasswordAdmin
            MATCH (at)-[:AZContains]->(PasswordAdminTargets:AZUser)-[:AZHasRole]->(arTargets)
            WHERE NOT PasswordAdminTargets IN NonTargets AND arTargets.templateid IN $PasswordAdminTargetRoles
            CALL {
                WITH PasswordAdmin, PasswordAdminTargets
                MERGE (PasswordAdmin)-[:AZResetPassword]->(PasswordAdminTargets)
            } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            PasswordAdminTargetRoles: [
                '88D8E3E3-8F55-4A1E-953A-9B9898B8876B',
                '95E79109-95C0-4D8E-AEE3-D01ACCF2D47B',
                '966707D0-3269-4727-9BE2-8C3A10F19B9D',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZResetPasswordEdges',
        description: `User Account Admins can reset the password for other users with one or more of the following roles:
    Directory Readers, Guest Inviter, Helpdesk Administrator, Message Center Reader, Reports Reader, User Account Administrator
    User Account Admin template id: fe930be7-5e62-47db-91af-98c3a49a38b1`,
        type: 'query',
        statement:
            `MATCH (at:AZTenant)-[:AZContains]->(UserAccountAdmin)-[:AZHasRole]->(UserAccountAdminRole:AZRole {templateid:"FE930BE7-5E62-47DB-91AF-98C3A49A38B1"})
            MATCH (NonTargets:AZUser)-[:AZHasRole]->(ar:AZRole)
            WHERE NOT ar.templateid IN $UserAccountAdminTargetRoles
            WITH COLLECT(NonTargets) AS NonTargets,at,UserAccountAdmin
            MATCH (at)-[:AZContains]->(UserAccountAdminTargets:AZUser)-[:AZHasRole]->(arTargets)
            WHERE NOT UserAccountAdminTargets IN NonTargets AND arTargets.templateid IN $UserAccountAdminTargetRoles
            CALL {
                WITH UserAccountAdmin, UserAccountAdminTargets
                MERGE (UserAccountAdmin)-[:AZResetPassword]->(UserAccountAdminTargets)
            } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            UserAccountAdminTargetRoles: [
                '88D8E3E3-8F55-4A1E-953A-9B9898B8876B',
                '95E79109-95C0-4D8E-AEE3-D01ACCF2D47B',
                '729827E3-9C14-49F7-BB1B-9608F156BBB8',
                '790C1FB9-7F7D-4F88-86A1-EF1F95C05C1B',
                '4A5D8F65-41DA-4DE4-8968-E035B65339CF',
                'FE930BE7-5E62-47DB-91AF-98C3A49A38B1',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZResetPassword Edges`,
    },
    {
        step: 'createAZAddSecretEdges',
        description: `Application Admin and Cloud App Admin can add secret to any tenant-resident app or service principal`,
        type: 'query',
        statement: `MATCH (at:AZTenant)
                    MATCH p = (at)-[:AZContains]->(Principal)-[:AZHasRole]->(Role)<-[:AZContains]-(at)
                    WHERE Role.templateid IN ['9B895D92-2CD3-44C7-9D02-A6AC2D5EA5C3','158C047A-C907-4556-B7EF-446551A6B5F7']
                    MATCH (at)-[:AZContains]->(target)
                    WHERE target:AZApp OR target:AZServicePrincipal
                    WITH Principal, target
                    CALL {
                        WITH Principal, target
                        MERGE (Principal)-[:AZAddSecret]->(target)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: null,
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZAddSecret Edges`,
    },
    {
        step: 'createAZExecuteCommandEdges',
        description: `InTune Administrators have the ability to execute SYSTEM commands on a Windows device by abusing Endpoint Manager`,
        type: 'query',
        statement: `MATCH (azt:AZTenant)
                    MATCH (azt)-[:AZContains]->(InTuneAdmin)-[:AZHasRole]->(azr:AZRole {templateid:'3A2C62DB-5318-420D-8D74-23AFFEE5D9D5'})
                    MATCH (azt)-[:AZContains]->(azd:AZDevice)
                    WHERE toUpper(azd.operatingsystem) CONTAINS "WINDOWS" AND azd.mdmappid IN ['54B943F8-D761-4F8D-951E-9CEA1846DB5A','0000000A-0000-0000-C000-000000000000']
                    CALL {
                        WITH InTuneAdmin, azd
                        MERGE (InTuneAdmin)-[:AZExecuteCommand]->(azd)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: null,
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZExecuteCommand Edges`,
    },
    {
        step: 'createAZAddMembersEdges',
        description: `These roles can alter memberships of non-role assignable security groups:
    GROUPS ADMIN, GLOBAL ADMIN, PRIV ROLE ADMIN, DIRECTORY WRITER, IDENTITY GOVERNANCE ADMIN, USER ADMINISTRATOR,
    INTUNE ADMINISTRATOR, KNOWLEDGE ADMINISTRATOR, KNOWLEDGE MANAGER`,
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $addGroupMembersRoles
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    MATCH (at)-[:AZContains]->(azg:AZGroup)
                    WHERE azg.isassignabletorole IS null
            OR azg.isassignabletorole = false
                    CALL {
                        WITH n, azg
                        MERGE (n)-[:AZAddMembers]->(azg)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            addGroupMembersRoles: [
                'FDD7A751-B60B-444A-984C-02652FE8FA1C',
                '62E90394-69F5-4237-9190-012177145E10',
                'E8611AB8-C189-46E8-94E1-60213AB1F814',
                '9360FEB5-F418-4BAA-8175-E2A00BAC4301',
                '45D8D3C5-C802-45C6-B32A-1D70B5E1E86E',
                'FE930BE7-5E62-47DB-91AF-98C3A49A38B1',
                '3A2C62DB-5318-420D-8D74-23AFFEE5D9D5',
                'B5A8DCF3-09D5-43A9-A639-8E29EF291470',
                '744EC460-397E-42AD-A462-8B3F9747A02C',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZAddMembers Edges`,
    },
    {
        step: 'createAZAddMembersEdges',
        description: `These roles can alter memberships of role assignable security groups: GLOBAL ADMIN, PRIV ROLE ADMIN`,
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $addGroupMembersRoles
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    MATCH (at)-[:AZContains]->(azg:AZGroup {isassignabletorole: true})
                    CALL {
                        WITH n,azg
                        MERGE (n)-[:AZAddMembers]->(azg)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            addGroupMembersRoles: [
                '62E90394-69F5-4237-9190-012177145E10',
                'E8611AB8-C189-46E8-94E1-60213AB1F814',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZAddMembers Edges`,
    },
    {
        step: 'createAZAddOwnerEdges',
        description: `These roles can update the owner of any AZApp: HYBRID IDENTITY ADMINISTRATOR, PARTNER TIER1 SUPPORT, PARTNER TIER2 SUPPORT, DIRECTORY SYNCHRONIZATION ACCOUNTS`,
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $addOwnerRoles
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    MATCH (at)-[:AZContains]->(aza:AZApp)
                    CALL {
                        WITH n, aza
                        MERGE (n)-[:AZAddOwner]->(aza)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            addOwnerRoles: [
                '8AC3FC64-6ECA-42EA-9E69-59F4C7B60EB2',
                '4BA39CA4-527C-499A-B93D-D9B492C50246',
                'E00E864A-17C5-4A4B-9C06-F5B95A8D5BD8',
                'D29B2B05-8046-44BA-8758-1E26182FCF32',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZAddOwner Edges`,
    },
    {
        step: 'createAZAddOwnerEdges',
        description: `These roles can update the owner of any AZServicePrincipal: HYBRID IDENTITY ADMINISTRATOR, PARTNER TIER1 SUPPORT, PARTNER TIER2 SUPPORT, DIRECTORY SYNCHRONIZATION ACCOUNTS`,
        type: 'query',
        statement: `MATCH (n)-[:AZHasRole]->(m)
                    WHERE m.templateid IN $addOwnerRoles
                    MATCH (at:AZTenant)-[:AZContains]->(n)
                    MATCH (at)-[:AZContains]->(azsp:AZServicePrincipal)
                    CALL {
                        WITH n, azsp
                        MERGE (n)-[:AZAddOwner]->(azsp)
                    } IN TRANSACTIONS OF {} ROWS`.format(batchSize),
        params: {
            addOwnerRoles: [
                '8AC3FC64-6ECA-42EA-9E69-59F4C7B60EB2',
                '4BA39CA4-527C-499A-B93D-D9B492C50246',
                'E00E864A-17C5-4A4B-9C06-F5B95A8D5BD8',
                'D29B2B05-8046-44BA-8758-1E26182FCF32',
            ],
        },
        log: (result) =>
            `Created ${
                result.summary.counters.updates().relationshipsCreated
            } AZAddOwner Edges`,
    },
];

const executePostProcessSteps = async (steps, session) => {
    for (let step of steps) {
        console.log(`At ${step.step} - ${step.type}`)
        if (step.type === 'query') {
            await session
                .run(step.statement, step.params)
                .catch((err) => {
                    console.log(err);
                })
                .then((res) => {
                    if (typeof step.log !== 'undefined')
                        try {
                            console.log(step.log(res));
                        } catch (err) {
                            console.log(err);
                        }
                });
        } else if (step.type === 'callback') {
            await step.callback(session);
        } else {
            console.log('Type of step unrecognized');
        }
        incrementPostProcessStep();
    }
};
// end of post-import steps from BloodHound/src/components/Menu/MenuContainer.jsx copied without modification

(async function main() {

    if (process.argv.length != 3) {
        console.log("Usage: node bin/app.js <preprocess|postprocess|BloodHound/AzureHound JSON file>");
        process.exit(0);
    }

    if (process.argv[2] == 'preprocess') {
        console.log("Setting schema")
        await setSchema();
    } else if (process.argv[2] == 'postprocess') {
        // run this only once after import of all
        let session = driver.session();
        console.log('Running Azure post-import steps')
        await executePostProcessSteps(AzurePostProcessSteps, session)
        console.log('Running AD post-import steps')
        await executePostProcessSteps(ADPostProcessSteps, session)
        await session.close();
    } else if (fs.existsSync(process.argv[2])) {
        var file = {path: process.argv[2]};
        var validFile = await checkFileValidity(file);
        if (validFile == null) {
            console.log(`Invalid file ${process.argv[2]}`)
            process.exit(0)
        }
        await processJson(validFile);

        readline.clearLine(process.stdout);
        readline.cursorTo(process.stdout, 0);
    } else {
        console.log("Usage: node bin/app.js <preprocess|postprocess|BloodHound/AzureHound JSON file>");
        process.exit(0);
    }

    console.log('Finished')

    process.exit(0)
})();
