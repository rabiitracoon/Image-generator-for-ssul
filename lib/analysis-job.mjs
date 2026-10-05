export const ANALYSIS_TIMEOUT_MS=300000;
export function analysisCancelled(){return Object.assign(Error('장면 분석을 중단했습니다. 기존 장면은 유지됩니다.'),{name:'AbortError'});}
export function retryableAnalysisError(error){return /응답 시간이 초과|timed? ?out|ECONN|ETIMEDOUT|connection|stream.*(disconnect|closed|reset)|429|rate.?limit|temporar|503|502/i.test(error.message);}
export function abortable(promise,signal){
 if(!signal)return promise;
 if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason||analysisCancelled());}
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason||analysisCancelled());signal.addEventListener('abort',abort,{once:true});
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
export async function runAnalysis({execute,validate,onPhase=async()=>{},signal,timeout=ANALYSIS_TIMEOUT_MS,retryDelay=1000}){
 for(let attempt=1;attempt<=2;attempt++){
  signal?.throwIfAborted();await onPhase(attempt===1?'waiting':'retrying',attempt);signal?.throwIfAborted();
  let result;
  try{result=await abortable(execute({signal,timeout,attempt}),signal);}
  catch(error){
   signal?.throwIfAborted();
   if(attempt===2||!retryableAnalysisError(error))throw error;
   await onPhase('retrying',attempt+1);
   await abortable(new Promise(resolve=>setTimeout(resolve,retryDelay)),signal);continue;
  }
  signal?.throwIfAborted();await onPhase('validating',attempt);
  const scenes=validate(result);signal?.throwIfAborted();return scenes;
 }
}
