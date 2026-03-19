const core = require( '@actions/core' );
if( typeof wTools === 'undefined' )
require( '../node_modules/Joined.s' );
const _ = wTools;
const GithubActionsParser = require( 'github-actions-parser' );
const fs = require( 'fs' );
const path = require( 'path' );
const childProcess = require( 'child_process' );

//

function commandsForm( command )
{
  _.assert( command.length > 0, 'Please, specify Github action name or shell command.' );

  if( command[ 0 ] === '|' )
  {
    _.assert( command.length > 1, 'Expected multiline command.' );
    command.shift();
  }

  _.assert( !_.str.ends( command[ command.length - 1 ], /\s\\/ ), 'Last command should have no continuation.' );

  if( process.platform === 'win32' )
  {
    command.unshift( `$ErrorActionPreference = 'stop'` );
    command.push( 'if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }' );
  }

  return command;
}

//

function remotePathForm( name, token )
{
  if( _.str.begins( name, [ './', 'docker:' ] ) )
  {
    _.assert( 0, 'unimplemented' );
  }
  else
  {
    name = name.replace( /^([^\/]+\/[^\/]+)\//, '$1.git/' );
    if( token )
    return _.git.path.parse( `https://oauth2:${ token }@github.com/${ _.str.replace( name, '@', '!' ) }` );
    else
    return _.git.path.parse( `https://github.com/${ _.str.replace( name, '@', '!' ) }` );
  }
}

//

function actionClone( localPath, remotePath )
{
  if( _.fileProvider.fileExists( localPath ) )
  return null;

  if( actionCacheRead( localPath, remotePath ) )
  return null;

  const con = _.take( null );
  con.then( () =>
  {
    return _.git.repositoryClone
    ({
      remotePath,
      localPath,
      sync : 0,
      attemptLimit : 4,
      attemptDelay : 500,
      attemptDelayMultiplier : 4,
    });
  });
  con.then( () =>
  {
    if( remotePath.tag !== 'master' )
    return _.git.tagLocalChange
    ({
      localPath,
      tag : remotePath.tag,
      sync : 0
    });
    return true;
  });
  con.then( () => { actionCacheWrite( localPath, remotePath ); return true; });
  return con;
}

//

function resolveShaFromRemote( remotePath )
{
  try
  {
    const url = `https://github.com/${ remotePath.repo }.git`;
    const out = childProcess.execSync( `git ls-remote "${ url }" "${ remotePath.tag }"`, { timeout : 10000 } ).toString().trim();
    const firstLine = out.split( '\n' )[ 0 ];
    return firstLine ? firstLine.split( '\t' )[ 0 ] : null;
  }
  catch( ex )
  {
    return null;
  }
}

//

function resolveClonedSha( localPath )
{
  try
  {
    return childProcess.execSync( 'git rev-parse HEAD', { cwd : localPath } ).toString().trim();
  }
  catch( ex )
  {
    return null;
  }
}

//

function actionCacheRead( localPath, remotePath )
{
  const cacheDir = process.env[ 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE' ];
  if( !cacheDir || !fs.existsSync( cacheDir ) )
  return false;

  const sha = resolveShaFromRemote( remotePath );
  if( !sha )
  return false;

  const repoKey = remotePath.repo.replace( /[/\\]/g, '_' );
  const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const archivePath = path.join( cacheDir, repoKey, sha + ext );
  if( !fs.existsSync( archivePath ) )
  return false;

  try
  {
    fs.mkdirSync( localPath, { recursive : true } );
    if( process.platform === 'win32' )
    {
      childProcess.execSync( `powershell -Command "Expand-Archive -Path '${ archivePath }' -DestinationPath '${ localPath }' -Force"` );
    }
    else
    {
      childProcess.execSync( `tar -xzf "${ archivePath }" -C "${ localPath }" --strip-components=1` );
    }
    core.info( `Loaded action from archive cache: ${ archivePath }` );
    return true;
  }
  catch( ex )
  {
    core.warning( `Failed to use action archive cache: ${ ex.message }` );
    return false;
  }
}

//

function actionCacheWrite( localPath, remotePath )
{
  const cacheDir = process.env[ 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE' ];
  if( !cacheDir || !fs.existsSync( cacheDir ) )
  return;

  const sha = resolveClonedSha( localPath );
  if( !sha )
  return;

  const repoKey = remotePath.repo.replace( /[/\\]/g, '_' );
  const repoCacheDir = path.join( cacheDir, repoKey );
  const ext = process.platform === 'win32' ? '.zip' : '.tar.gz';
  const archivePath = path.join( repoCacheDir, sha + ext );

  try
  {
    fs.mkdirSync( repoCacheDir, { recursive : true } );
    if( process.platform === 'win32' )
    {
      childProcess.execSync( `powershell -Command "Compress-Archive -Path '${ localPath }\\*' -DestinationPath '${ archivePath }' -Force"` );
    }
    else
    {
      const parentDir = path.dirname( localPath );
      const folderName = path.basename( localPath );
      childProcess.execSync( `tar -czf "${ archivePath }" -C "${ parentDir }" "${ folderName }"` );
    }
    core.info( `Saved action to archive cache: ${ archivePath }` );
  }
  catch( ex )
  {
    core.warning( `Failed to save action to archive cache: ${ ex.message }` );
  }
}

//

function actionConfigRead( actionDir )
{
  let configPath = _.path.join( actionDir, 'action.yml' );
  if( !_.fileProvider.fileExists( configPath ) )
  configPath = _.path.join( actionDir, 'action.yaml' )

  _.assert( _.fileProvider.fileExists( configPath ), 'Expects action path `action.yml` or `action.yaml` in the action dir: ' + actionDir );

  return _.fileProvider.fileRead
  ({
    filePath : configPath,
    encoding : 'yaml',
  });
}

//

function actionOptionsParse( src )
{
  const jsYaml = require( 'js-yaml' );
  return jsYaml.load( src ) || {};
}

//

function optionsExtendByInputDefaults( options, inputs )
{
  const result = Object.create( null );

  for( let key in options )
  result[ key ] = options[ key ];

  if( inputs )
  {
    for( let key in inputs )
    {
      if( key in options )
      {
        if( inputs[ key ].required )
        _.sure( options[ key ] !== undefined, `Please, provide value for option "${ key }"` )
      }
      else
      {
        const defaultValue = inputs[ key ].default;
        if( inputs[ key ].required )
        _.sure( defaultValue !== undefined, `Please, provide value for option "${ key }"` )

        let value = defaultValue;
        if( _.str.is( value ) )
        if( value.startsWith( '${{' ) && value.endsWith( '}}' ) )
        {
          value = evaluateExpression( value );
        }
        result[ key ] = value;
      }
    }
  }

  return result;
}

//

function envOptionsFrom( options )
{
  const result = Object.create( null );
  for( let key in options )
  result[ `INPUT_${ key.replace( / /g, '_' ).toUpperCase() }` ] = options[ key ];
  return result;
}

//

function contextGet( contextName )
{
  if( contextName === 'env' )
  {
    let envContext = JSON.parse( core.getInput( 'env_context' ) );
    if( _.map.keys( envContext ).length === 0 )
    return process.env;
    return envContext;
  }
  else if( contextName === 'github' )
  {
    let githubContext = JSON.parse( core.getInput( 'github_context' ) );
    githubContext = githubContextUpdate( githubContext );
    return githubContext;
  }
  else if( contextName === 'steps' )
  {
    const context = JSON.parse( core.getInput( `${ contextName }_context` ) );
    if( _.fileProvider.fileExists( process.env.GITHUB_OUTPUT ) )
    {
      const rawFile = _.fileProvider.fileRead({ filePath : process.env.GITHUB_OUTPUT });
      const regex = /^(.*)<<ghadelimiter_(.*)(\s*)(.+)\3ghadelimiter_\2/mg;
      const filteredFile = rawFile.replaceAll( regex, '$1=$4' );
      const Ini = require( 'ini' );
      const parsed = Ini.parse( filteredFile );
      context._this = { outputs : parsed, outcome : 'failure', conclusion : 'failure' };
    }
    return context;
  }
  else if(  [ 'job', 'matrix', 'inputs' ].includes( contextName ) )
  {
    const context = JSON.parse( core.getInput( `${ contextName }_context` ) );
    return context;
  }

  _.sure
  (
    false,
    `The requested context "${ contextName }" does not supported by action.`
    + '\nPlease, open an issue with the request for the feature.'
  );

  /* */

  function githubContextUpdate( githubContext )
  {
    if( process.env.RETRY_ACTION )
    {
      const remoteActionPath = remotePathForm( process.env.RETRY_ACTION );
      const localActionPath = _.path.nativize( _.path.join( __dirname, '../../../', remoteActionPath.repo ) );
      githubContext.action_path = localActionPath;
      githubContext.action_ref = remoteActionPath.tag;
    }
    return githubContext;
  }
}

//

function envOptionsSetup( options )
{
  for( let key in options )
  core.exportVariable( key, options[ key ] );
}

//

function shouldExit( config, scriptType )
{
  const using = config.runs.using;
  if( _.strBegins( using, 'node' ) || using === 'docker' )
  {
    if( using === 'docker' && scriptType === 'main' )
    return false;

    const localScriptType = using === 'docker' ? `${ scriptType }-entrypoint` : scriptType;
    if( !config.runs[ localScriptType ] )
    return true;

    if( config.runs[ `${ scriptType }-if` ] )
    {
      return !evaluateExpression( config.runs[ `${ scriptType }-if` ] );
    }
  }

  return false;
}

//

function evaluateExpression( expression, getter )
{
  return GithubActionsParser.evaluateExpression( expression, { get : getter || contextGet } );
}

// --
// export
// --

const Self =
{
  commandsForm,
  remotePathForm,
  actionClone,
  actionCacheRead,
  actionCacheWrite,
  resolveClonedSha,
  resolveShaFromRemote,
  actionConfigRead,
  actionOptionsParse,
  optionsExtendByInputDefaults,
  envOptionsFrom,
  contextGet,
  envOptionsSetup,
  shouldExit,
  evaluateExpression,
};

module.exports = Self;

