// Engine kernels for the CyberFly brain server (see engine/RESULTS.md).
//
// ref_advance  : verbatim copy of fly-wirehead's kernel.cpp memory_advance (only renamed).
// fast_advance : SAME signature, SAME arithmetic, SAME operation order. Only the memory
//                layout changes: the per-neuron hot state (last, v, g, adaptation, rest,
//                drive, refractory, flag, kc) is packed into one 32-byte cell for the
//                duration of the call, so a synaptic delivery touches one cache line
//                instead of ~8, plus software prefetch of upcoming targets. The float
//                expressions are textually identical, so with the same compiler/flags
//                results are bit-identical (proven by engine/test_equality.py).
//
// Nothing here changes dt, thresholds, delays, weights, edges or neurons.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <pthread.h>
#include <pthread/qos.h>
#include <thread>
#include <vector>

extern "C" void ref_advance(
 int n,const int64_t* ptr,const int32_t* post,float* weight,
 float* v,float* g,int16_t* refractory,const float* drive,float* previous_drive,
 int32_t* queue,int32_t* queue_count,int64_t* clock,int steps,float dt,int32_t* counts,
 int32_t* active,uint8_t* flags,int32_t* nactive,int64_t* last,
 const uint8_t* kc_mask,const int8_t* dan_index,double* eligibility,int64_t* eligibility_last,
 int nplastic,const int64_t* plastic_edge,const int32_t* plastic_pre,
 const float* baseline_weight,const float* dan_gain,float eta,float tau_elig_ms,float floor_fraction,
 int learning_enabled,float* modulation,int64_t* modulation_last,const uint8_t* modulation_mask,const float* rest,
 float* adaptation,float adaptation_jump,float adaptation_tau) {
 const int delay=std::lround(1.8f/dt),rfc=std::lround(2.2f/dt),slots=delay+1;
 float av[1024],ag[1024],aa[1024];
 for(int i=0;i<1024;i++){av[i]=std::exp(-dt*i/20.f);ag[i]=std::exp(-dt*i/5.f);aa[i]=std::exp(-dt*i/adaptation_tau);}
 auto evolve=[&](int i,int64_t now,float current){
   int64_t d=now-last[i];if(d<=0)return;
   const int frozen=refractory[i]>0?refractory[i]-1:0;
   const int skip=(int)(d<frozen?d:frozen);
   if(skip>0 && adaptation[i]>0)adaptation[i]*=skip<1024?aa[skip]:std::exp(-dt*skip/adaptation_tau);
   refractory[i]=d>=refractory[i]?0:refractory[i]-d;d-=skip;
   if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
     v[i]=rest[i]+(v[i]-rest[i])*a+current*(1.f-a)+g[i]*(a-b)/3.f;g[i]*=b;
     if(adaptation[i]>0){const float c=d<1024?aa[d]:std::exp(-dt*d/adaptation_tau);
       v[i]-=adaptation[i]*adaptation_tau/(adaptation_tau-20.f)*(c-a);adaptation[i]*=c;}
   }
   last[i]=now;
 };
 auto awaken=[&](int i){if(!flags[i]){flags[i]=1;active[(*nactive)++]=i;}};
 for(int i=0;i<n;i++)if(drive[i]!=previous_drive[i]){
   evolve(i,*clock-1,previous_drive[i]);previous_drive[i]=drive[i];awaken(i);
 }
 for(int t=0;t<steps;t++,(*clock)++){
   const int slot=*clock%slots,future=(*clock+delay)%slots;
   int kept=0,original=*nactive;
   for(int k=0;k<original;k++){
     const int i=active[k];evolve(i,*clock,drive[i]);
     if(refractory[i]==0 && v[i]>-45.f){queue[future*n+queue_count[future]++]=i;counts[i]++;
       if(kc_mask[i]){
         adaptation[i]+=adaptation_jump;
         eligibility[i]*=std::exp(-dt*(*clock-eligibility_last[i])/tau_elig_ms);
         eligibility[i]+=1.;eligibility_last[i]=*clock;
       }
     }
     const float gap=-45.f-rest[i];
     const bool can_fire=v[i]>-45.f || drive[i]>gap || drive[i]+g[i]>gap;
     if(can_fire)active[kept++]=i;else flags[i]=0;
   }
   *nactive=kept;
   for(int q=0;q<queue_count[slot];q++){
     const int i=queue[slot*n+q];
     if(modulation_mask[i]){
       for(int64_t e=ptr[i];e<ptr[i+1];e++){
         const int j=post[e];
         modulation[j]*=std::exp(-dt*(*clock-modulation_last[j])/100.f);
         modulation[j]+=std::abs(weight[e])/.275f;modulation_last[j]=*clock;
       }
       if(learning_enabled && dan_index[i]>=0){
         for(int p=0;p<nplastic;p++){
           const int pre=plastic_pre[p];
           const double trace=eligibility[pre]*std::exp(-dt*(*clock-eligibility_last[pre])/tau_elig_ms);
           const float gain=dan_gain[dan_index[i]*nplastic+p];
           const int64_t edge=plastic_edge[p];
           const float candidate=weight[edge]*std::exp(-eta*gain*trace);
           const float lower=baseline_weight[p]*floor_fraction;
           weight[edge]=candidate>lower?candidate:lower;
         }
       }
       continue;
     }
     for(int64_t e=ptr[i];e<ptr[i+1];e++){
       const int j=post[e];evolve(j,*clock,drive[j]);
       if(refractory[j]==0){g[j]+=weight[e];awaken(j);}
     }
   }
   queue_count[slot]=0;
   for(int q=0;q<queue_count[future];q++){
     const int i=queue[future*n+q];v[i]=rest[i];g[i]=0.f;refractory[i]=rfc;
   }
 }
 for(int i=0;i<n;i++)evolve(i,*clock-1,drive[i]);
}

namespace {
struct alignas(32) Cell {
  int64_t last;
  float v, g, adapt, rest, drive;
  int16_t refr;
  uint8_t flag, kc;
};
static_assert(sizeof(Cell) == 32, "Cell must be 32 bytes");
constexpr int PF_EDGE = 12;   // prefetch distance along an outgoing edge list
constexpr int PF_ACTIVE = 12; // prefetch distance along the active list
}  // namespace

extern "C" void fast_advance(
 int n,const int64_t* ptr,const int32_t* post,float* weight,
 float* v,float* g,int16_t* refractory,const float* drive,float* previous_drive,
 int32_t* queue,int32_t* queue_count,int64_t* clock,int steps,float dt,int32_t* counts,
 int32_t* active,uint8_t* flags,int32_t* nactive,int64_t* last,
 const uint8_t* kc_mask,const int8_t* dan_index,double* eligibility,int64_t* eligibility_last,
 int nplastic,const int64_t* plastic_edge,const int32_t* plastic_pre,
 const float* baseline_weight,const float* dan_gain,float eta,float tau_elig_ms,float floor_fraction,
 int learning_enabled,float* modulation,int64_t* modulation_last,const uint8_t* modulation_mask,const float* rest,
 float* adaptation,float adaptation_jump,float adaptation_tau) {
 const int delay=std::lround(1.8f/dt),rfc=std::lround(2.2f/dt),slots=delay+1;
 float av[1024],ag[1024],aa[1024];
 for(int i=0;i<1024;i++){av[i]=std::exp(-dt*i/20.f);ag[i]=std::exp(-dt*i/5.f);aa[i]=std::exp(-dt*i/adaptation_tau);}
 thread_local std::vector<Cell> cells;
 cells.resize(n);
 Cell* S=cells.data();
 for(int i=0;i<n;i++){
   Cell& c=S[i];
   c.last=last[i];c.v=v[i];c.g=g[i];c.adapt=adaptation[i];c.rest=rest[i];c.drive=drive[i];
   c.refr=refractory[i];c.flag=flags[i];c.kc=kc_mask[i];
 }
 const int64_t E=ptr[n];
 // Same statements as ref_advance with v[i]->c.v, g[i]->c.g, adaptation[i]->c.adapt, ...
 auto evolve=[&](Cell& c,int64_t now,float current){
   int64_t d=now-c.last;if(d<=0)return;
   const int frozen=c.refr>0?c.refr-1:0;
   const int skip=(int)(d<frozen?d:frozen);
   if(skip>0 && c.adapt>0)c.adapt*=skip<1024?aa[skip]:std::exp(-dt*skip/adaptation_tau);
   c.refr=d>=c.refr?0:c.refr-d;d-=skip;
   if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
     c.v=c.rest+(c.v-c.rest)*a+current*(1.f-a)+c.g*(a-b)/3.f;c.g*=b;
     if(c.adapt>0){const float cc=d<1024?aa[d]:std::exp(-dt*d/adaptation_tau);
       c.v-=c.adapt*adaptation_tau/(adaptation_tau-20.f)*(cc-a);c.adapt*=cc;}
   }
   c.last=now;
 };
 auto awaken=[&](int i){if(!S[i].flag){S[i].flag=1;active[(*nactive)++]=i;}};
 for(int i=0;i<n;i++)if(drive[i]!=previous_drive[i]){
   evolve(S[i],*clock-1,previous_drive[i]);previous_drive[i]=drive[i];awaken(i);
 }
 for(int t=0;t<steps;t++,(*clock)++){
   const int slot=*clock%slots,future=(*clock+delay)%slots;
   int kept=0,original=*nactive;
   for(int k=0;k<original;k++){
     if(k+PF_ACTIVE<original)__builtin_prefetch(&S[active[k+PF_ACTIVE]],1);
     const int i=active[k];Cell& c=S[i];evolve(c,*clock,c.drive);
     if(c.refr==0 && c.v>-45.f){queue[future*n+queue_count[future]++]=i;counts[i]++;
       if(c.kc){
         c.adapt+=adaptation_jump;
         eligibility[i]*=std::exp(-dt*(*clock-eligibility_last[i])/tau_elig_ms);
         eligibility[i]+=1.;eligibility_last[i]=*clock;
       }
     }
     const float gap=-45.f-c.rest;
     const bool can_fire=c.v>-45.f || c.drive>gap || c.drive+c.g>gap;
     if(can_fire)active[kept++]=i;else c.flag=0;
   }
   *nactive=kept;
   for(int q=0;q<queue_count[slot];q++){
     const int i=queue[slot*n+q];
     if(modulation_mask[i]){
       for(int64_t e=ptr[i];e<ptr[i+1];e++){
         const int j=post[e];
         modulation[j]*=std::exp(-dt*(*clock-modulation_last[j])/100.f);
         modulation[j]+=std::abs(weight[e])/.275f;modulation_last[j]=*clock;
       }
       if(learning_enabled && dan_index[i]>=0){
         for(int p=0;p<nplastic;p++){
           const int pre=plastic_pre[p];
           const double trace=eligibility[pre]*std::exp(-dt*(*clock-eligibility_last[pre])/tau_elig_ms);
           const float gain=dan_gain[dan_index[i]*nplastic+p];
           const int64_t edge=plastic_edge[p];
           const float candidate=weight[edge]*std::exp(-eta*gain*trace);
           const float lower=baseline_weight[p]*floor_fraction;
           weight[edge]=candidate>lower?candidate:lower;
         }
       }
       continue;
     }
     const int64_t e1=ptr[i+1];
     for(int64_t e=ptr[i];e<e1;e++){
       if(e+PF_EDGE<E)__builtin_prefetch(&S[post[e+PF_EDGE]],1);
       const int j=post[e];Cell& c=S[j];evolve(c,*clock,c.drive);
       if(c.refr==0){c.g+=weight[e];awaken(j);}
     }
   }
   queue_count[slot]=0;
   for(int q=0;q<queue_count[future];q++){
     const int i=queue[future*n+q];Cell& c=S[i];c.v=c.rest;c.g=0.f;c.refr=rfc;
   }
 }
 for(int i=0;i<n;i++)evolve(S[i],*clock-1,S[i].drive);
 for(int i=0;i<n;i++){
   const Cell& c=S[i];
   last[i]=c.last;v[i]=c.v;g[i]=c.g;adaptation[i]=c.adapt;refractory[i]=c.refr;flags[i]=c.flag;
 }
}

// ---------------------------------------------------------------------------------------
// par_advance : ONE fly on R threads, still bit-identical to memory_advance.
//
// Neurons are owned block-cyclically ((j/block)%R). Thread r touches only the state of
// neurons it owns: its own active list, and for every spike in the (global, ordered) delay
// queue it walks only the sub-row of edges whose target it owns (a pre-split copy of the
// frozen CSR, built once per process and shared by all flies). So every neuron sees exactly
// the original sequence of operations: phase-1 update, deliveries in queue order (same
// float summation order into g), phase-3 reset.
// The original's only cross-neuron order is the active list (append order = queue order).
// It is reproduced exactly with a sort key per active entry: (awakening time, global
// delivery sequence = prefix of out-degrees in queue order + edge offset in the row).
// Per-thread lists stay sorted by key; spikes are merged by key into the global queue
// each tick, and the active lists are merged back into `active` at exit.
// Learning (weight writes) is not supported here -> falls back to fast_advance.
namespace {
struct Edge { int32_t post; float w; int32_t off; };
struct Partition {
  int n=0,R=1,block=64;
  std::vector<std::vector<int64_t>> ptr;  // [R][n+1]
  std::vector<std::vector<Edge>> edges;   // [R][sub-row edges]
};
struct alignas(128) Barrier {
  std::atomic<int> count{0};
  alignas(128) std::atomic<int> gen{0};
  int total=1;
  void wait(){
    const int g0=gen.load(std::memory_order_acquire);
    if(count.fetch_add(1,std::memory_order_acq_rel)==total-1){
      count.store(0,std::memory_order_relaxed);gen.fetch_add(1,std::memory_order_release);return;
    }
    for(int spin=0;gen.load(std::memory_order_acquire)==g0;spin++){
      if(spin<4000){
#if defined(__aarch64__)
        __asm__ volatile("yield");
#endif
      }else std::this_thread::yield();
    }
  }
};
struct Local {
  std::vector<int32_t> act; std::vector<uint64_t> key;  // owned active list, sorted by key
  std::vector<int32_t> sp[2]; std::vector<uint64_t> spk[2];  // this tick's spikes (double-buffered)
};
// k-way merge of R key-sorted lists; emit(i) in key order
template<class F> void merge_lists(int R,const std::vector<int32_t>* const* ids,const std::vector<uint64_t>* const* keys,F emit){
  size_t pos[64]={0};
  for(;;){
    int best=-1;uint64_t bk=0;
    for(int r=0;r<R;r++)if(pos[r]<ids[r]->size()){const uint64_t k=(*keys[r])[pos[r]];if(best<0||k<bk){best=r;bk=k;}}
    if(best<0)return;
    emit((*ids[best])[pos[best]++]);
  }
}
}  // namespace

extern "C" void* part_build(int n,const int64_t* ptr,const int32_t* post,const float* weight,int R,int block){
  if(R<1||R>64||block<1)return nullptr;
  auto* P=new Partition;P->n=n;P->R=R;P->block=block;
  P->ptr.assign(R,std::vector<int64_t>(n+1,0));P->edges.resize(R);
  std::vector<std::thread> th;
  for(int r=0;r<R;r++)th.emplace_back([=]{
    auto& sp=P->ptr[r];int64_t cnt=0;
    for(int i=0;i<n;i++){sp[i]=cnt;for(int64_t e=ptr[i];e<ptr[i+1];e++)if((post[e]/block)%R==r)cnt++;}
    sp[n]=cnt;auto& ed=P->edges[r];ed.resize(cnt);int64_t k=0;
    for(int i=0;i<n;i++)for(int64_t e=ptr[i];e<ptr[i+1];e++)if((post[e]/block)%R==r)ed[k++]={post[e],weight[e],(int32_t)(e-ptr[i])};
  });
  for(auto& t:th)t.join();
  return P;
}
extern "C" void part_free(void* p){delete (Partition*)p;}

extern "C" void par_advance(
 int n,const int64_t* ptr,const int32_t* post,float* weight,
 float* v,float* g,int16_t* refractory,const float* drive,float* previous_drive,
 int32_t* queue,int32_t* queue_count,int64_t* clock,int steps,float dt,int32_t* counts,
 int32_t* active,uint8_t* flags,int32_t* nactive,int64_t* last,
 const uint8_t* kc_mask,const int8_t* dan_index,double* eligibility,int64_t* eligibility_last,
 int nplastic,const int64_t* plastic_edge,const int32_t* plastic_pre,
 const float* baseline_weight,const float* dan_gain,float eta,float tau_elig_ms,float floor_fraction,
 int learning_enabled,float* modulation,int64_t* modulation_last,const uint8_t* modulation_mask,const float* rest,
 float* adaptation,float adaptation_jump,float adaptation_tau,void* handle) {
 const Partition* PP=(const Partition*)handle;
 if(learning_enabled||!PP||PP->n!=n){
   fast_advance(n,ptr,post,weight,v,g,refractory,drive,previous_drive,queue,queue_count,clock,steps,dt,counts,
     active,flags,nactive,last,kc_mask,dan_index,eligibility,eligibility_last,nplastic,plastic_edge,plastic_pre,
     baseline_weight,dan_gain,eta,tau_elig_ms,floor_fraction,learning_enabled,modulation,modulation_last,
     modulation_mask,rest,adaptation,adaptation_jump,adaptation_tau);
   return;
 }
 const Partition& P=*PP;
 const int R=P.R,BL=P.block;
 const int delay=std::lround(1.8f/dt),rfc=std::lround(2.2f/dt),slots=delay+1;
 float av[1024],ag[1024],aa[1024];
 for(int i=0;i<1024;i++){av[i]=std::exp(-dt*i/20.f);ag[i]=std::exp(-dt*i/5.f);aa[i]=std::exp(-dt*i/adaptation_tau);}
 thread_local std::vector<Cell> cells;
 thread_local std::vector<Local> locals;
 cells.resize(n);locals.resize(R);
 Cell* S=cells.data();
 Local* const LS=locals.data();  // worker threads must use this: `locals` names THEIR own thread_local
 const int64_t clock0=*clock;
 for(int r=0;r<R;r++){Local& L=locals[r];L.act.clear();L.key.clear();for(int b=0;b<2;b++){L.sp[b].clear();L.spk[b].clear();}
   L.act.reserve(n/R+BL);L.key.reserve(n/R+BL);}
 for(int k=0;k<*nactive;k++){const int i=active[k];Local& L=locals[(i/BL)%R];L.act.push_back(i);L.key.push_back((uint64_t)k);}
 const std::vector<int32_t>* ids[64];const std::vector<uint64_t>* keys[64];
 auto flush=[&](int buf,int64_t clk){  // tick clk done by all threads: reset its slot, publish its spikes
   queue_count[clk%slots]=0;
   const int fs=(clk+delay)%slots;int32_t* qf=queue+(int64_t)fs*n;int32_t base=queue_count[fs];
   for(int r=0;r<R;r++){ids[r]=&locals[r].sp[buf];keys[r]=&locals[r].spk[buf];}
   merge_lists(R,ids,keys,[&](int32_t i){qf[base++]=i;});
   queue_count[fs]=base;
 };
 Barrier bar;bar.total=R;
 auto body=[&](int r){
   Local& L=LS[r];
   // Same statements as ref_advance/fast_advance.
   auto evolve=[&](Cell& c,int64_t now,float current){
     int64_t d=now-c.last;if(d<=0)return;
     const int frozen=c.refr>0?c.refr-1:0;
     const int skip=(int)(d<frozen?d:frozen);
     if(skip>0 && c.adapt>0)c.adapt*=skip<1024?aa[skip]:std::exp(-dt*skip/adaptation_tau);
     c.refr=d>=c.refr?0:c.refr-d;d-=skip;
     if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
       c.v=c.rest+(c.v-c.rest)*a+current*(1.f-a)+c.g*(a-b)/3.f;c.g*=b;
       if(c.adapt>0){const float cc=d<1024?aa[d]:std::exp(-dt*d/adaptation_tau);
         c.v-=c.adapt*adaptation_tau/(adaptation_tau-20.f)*(cc-a);c.adapt*=cc;}
     }
     c.last=now;
   };
   for(int b0=r*BL;b0<n;b0+=R*BL)for(int i=b0,e=std::min(b0+BL,n);i<e;i++){
     Cell& c=S[i];
     c.last=last[i];c.v=v[i];c.g=g[i];c.adapt=adaptation[i];c.rest=rest[i];c.drive=drive[i];
     c.refr=refractory[i];c.flag=flags[i];c.kc=kc_mask[i];
   }
   // Sensory-current change: owned neurons in index order (key = (1, i)).
   for(int b0=r*BL;b0<n;b0+=R*BL)for(int i=b0,e=std::min(b0+BL,n);i<e;i++)if(drive[i]!=previous_drive[i]){
     evolve(S[i],clock0-1,previous_drive[i]);previous_drive[i]=drive[i];
     if(!S[i].flag){S[i].flag=1;L.act.push_back(i);L.key.push_back((uint64_t(1)<<32)|(uint64_t)i);}
   }
   const std::vector<int64_t>& sptr=P.ptr[r];const Edge* ed=P.edges[r].data();const int64_t ecount=(int64_t)P.edges[r].size();
   for(int t=0;t<steps;t++){
     const int64_t clk=clock0+t;
     const int slot=clk%slots;
     if(r==0&&t>0)flush((t-1)&1,clk-1);
     std::vector<int32_t>& SP=L.sp[t&1];std::vector<uint64_t>& SK=L.spk[t&1];SP.clear();SK.clear();
     size_t kept=0;const size_t original=L.act.size();
     for(size_t k=0;k<original;k++){
       if(k+PF_ACTIVE<original)__builtin_prefetch(&S[L.act[k+PF_ACTIVE]],1);
       const int i=L.act[k];Cell& c=S[i];evolve(c,clk,c.drive);
       if(c.refr==0 && c.v>-45.f){SP.push_back(i);SK.push_back(L.key[k]);counts[i]++;
         if(c.kc){
           c.adapt+=adaptation_jump;
           eligibility[i]*=std::exp(-dt*(clk-eligibility_last[i])/tau_elig_ms);
           eligibility[i]+=1.;eligibility_last[i]=clk;
         }
       }
       const float gap=-45.f-c.rest;
       const bool can_fire=c.v>-45.f || c.drive>gap || c.drive+c.g>gap;
       if(can_fire){L.act[kept]=i;L.key[kept]=L.key[k];kept++;}else c.flag=0;
     }
     L.act.resize(kept);L.key.resize(kept);
     const uint64_t T=uint64_t(2+t)<<32;
     uint64_t prefix=0;
     const int qc=queue_count[slot];const int32_t* qs=queue+(int64_t)slot*n;
     for(int q=0;q<qc;q++){
       const int i=qs[q];
       const int64_t e0=sptr[i],e1=sptr[i+1];
       if(modulation_mask[i]){
         for(int64_t e=e0;e<e1;e++){
           const int j=ed[e].post;
           modulation[j]*=std::exp(-dt*(clk-modulation_last[j])/100.f);
           modulation[j]+=std::abs(ed[e].w)/.275f;modulation_last[j]=clk;
         }
       }else{
         for(int64_t e=e0;e<e1;e++){
           if(e+PF_EDGE<ecount)__builtin_prefetch(&S[ed[e+PF_EDGE].post],1);
           const int j=ed[e].post;Cell& c=S[j];evolve(c,clk,c.drive);
           if(c.refr==0){c.g+=ed[e].w;
             if(!c.flag){c.flag=1;L.act.push_back(j);L.key.push_back(T|(prefix+(uint64_t)ed[e].off));}}
         }
       }
       prefix+=(uint64_t)(ptr[i+1]-ptr[i]);
     }
     for(const int i:SP){Cell& c=S[i];c.v=c.rest;c.g=0.f;c.refr=rfc;}
     bar.wait();
   }
   if(r==0&&steps>0)flush((steps-1)&1,clock0+steps-1);
   const int64_t end=clock0+steps-1;
   for(int b0=r*BL;b0<n;b0+=R*BL)for(int i=b0,e=std::min(b0+BL,n);i<e;i++){
     Cell& c=S[i];evolve(c,end,c.drive);
     last[i]=c.last;v[i]=c.v;g[i]=c.g;adaptation[i]=c.adapt;refractory[i]=c.refr;flags[i]=c.flag;
   }
 };
 std::vector<std::thread> th;
 for(int r=1;r<R;r++)th.emplace_back([&,r]{pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE,0);body(r);});
 body(0);
 for(auto& t:th)t.join();
 *clock=clock0+steps;
 int32_t na=0;
 for(int r=0;r<R;r++){ids[r]=&locals[r].act;keys[r]=&locals[r].key;}
 merge_lists(R,ids,keys,[&](int32_t i){active[na++]=i;});
 *nactive=na;
}
