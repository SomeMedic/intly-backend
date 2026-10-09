// Executed by mongosh inside the Mongo container. Credentials stay in its environment.
const admin = db.getSiblingDB('admin');
try {
  const authentication = admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
  if (authentication !== 1 && authentication?.ok !== 1) quit(1);
  let status;
  try { status = admin.runCommand({ replSetGetStatus: 1 }); }
  catch (error) { status = error; }
  if (status.ok !== 1) {
    if (status.codeName !== 'NotYetInitialized' && status.code !== 94) quit(1);
    const result = admin.runCommand({ replSetInitiate: { _id: 'intly-rs', members: [{ _id: 0, host: 'mongo:27017' }] } });
    if (result.ok !== 1 && result.codeName !== 'AlreadyInitialized') quit(1);
  }
  const hello = admin.runCommand({ hello: 1 });
  quit(hello.setName === 'intly-rs' && hello.isWritablePrimary ? 0 : 1);
} catch { quit(1); }
