import { buildKernel } from '../src/qq/kernel/build.mjs';
try {
  const result=await buildKernel({ runtimeDirectory:process.env.QQ_RUNTIME_DIR||'./runtime/qq', directory:process.env.QQ_KERNEL_DIR||'./runtime/kernel' });
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
