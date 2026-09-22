// Instrumented copy of engine/kernel_batch.cpp fast_advance (same arithmetic), used only by
// profile_cpu.py to measure where CPU time goes and how parallel a tick is.
// stats[] layout (accumulated over all ticks of the call), see profile_cpu.py STATS.
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>
#include <algorithm>
namespace {
struct alignas(32) Cell { int64_t last; float v, g, adapt, rest, drive; int16_t refr; uint8_t flag, kc; };
inline double now_ns(){return (double)std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}
}
extern "C" void prof_advance(
 int n,const int64_t* ptr,const int32_t* post,float* weight,
 float* v,float* g,int16_t* refractory,const float* drive,float* previous_drive,
 int32_t* queue,int32_t* queue_count,int64_t* clock,int steps,float dt,int32_t* counts,
 int32_t* active,uint8_t* flags,int32_t* nactive,int64_t* last,
 const uint8_t* kc_mask,const int8_t* dan_index,double* eligibility,int64_t* eligibility_last,
 int nplastic,const int64_t* plastic_edge,const int32_t* plastic_pre,
 const float* baseline_weight,const float* dan_gain,float eta,float tau_elig_ms,float floor_fraction,
 int learning_enabled,float* modulation,int64_t* modulation_last,const uint8_t* modulation_mask,const float* rest,
 float* adaptation,float adaptation_jump,float adaptation_tau,double* stats) {
 const int delay=std::lround(1.8f/dt),rfc=std::lround(2.2f/dt),slots=delay+1;
 float av[1024],ag[1024],aa[1024];
 for(int i=0;i<1024;i++){av[i]=std::exp(-dt*i/20.f);ag[i]=std::exp(-dt*i/5.f);aa[i]=std::exp(-dt*i/adaptation_tau);}
 double T0=now_ns();
 static std::vector<Cell> cells; cells.resize(n); Cell* S=cells.data();
 static std::vector<int32_t> hits, stamp; hits.assign(n,0); stamp.assign(n,-1);
 for(int i=0;i<n;i++){Cell& c=S[i];c.last=last[i];c.v=v[i];c.g=g[i];c.adapt=adaptation[i];c.rest=rest[i];c.drive=drive[i];c.refr=refractory[i];c.flag=flags[i];c.kc=kc_mask[i];}
 auto evolve=[&](Cell& c,int64_t now,float current){
   int64_t d=now-c.last;if(d<=0)return;
   const int frozen=c.refr>0?c.refr-1:0; const int skip=(int)(d<frozen?d:frozen);
   if(skip>0 && c.adapt>0)c.adapt*=skip<1024?aa[skip]:std::exp(-dt*skip/adaptation_tau);
   c.refr=d>=c.refr?0:c.refr-d;d-=skip;
   if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
     c.v=c.rest+(c.v-c.rest)*a+current*(1.f-a)+c.g*(a-b)/3.f;c.g*=b;
     if(c.adapt>0){const float cc=d<1024?aa[d]:std::exp(-dt*d/adaptation_tau);c.v-=c.adapt*adaptation_tau/(adaptation_tau-20.f)*(cc-a);c.adapt*=cc;}}
   c.last=now;
 };
 int64_t awakened=0;
 auto awaken=[&](int i){if(!S[i].flag){S[i].flag=1;active[(*nactive)++]=i;awakened++;}};
 for(int i=0;i<n;i++)if(drive[i]!=previous_drive[i]){evolve(S[i],*clock-1,previous_drive[i]);previous_drive[i]=drive[i];awaken(i);}
 double tp1=0,tp2=0,tp3=0; double s_active=0,s_spk=0,s_del=0,s_mdel=0,s_touch=0,s_multi_t=0,s_multi_d=0,s_maxk=0,s_wake=0,s_qlen=0,s_ticks=0;
 double h[6]={0,0,0,0,0,0};
 std::vector<int> touched; touched.reserve(1<<16);
 for(int t=0;t<steps;t++,(*clock)++){
   const int slot=*clock%slots,future=(*clock+delay)%slots;
   double a0=now_ns();
   int kept=0,original=*nactive; s_active+=original;
   for(int k=0;k<original;k++){
     const int i=active[k];Cell& c=S[i];evolve(c,*clock,c.drive);
     if(c.refr==0 && c.v>-45.f){queue[future*n+queue_count[future]++]=i;counts[i]++;s_spk++;
       if(c.kc){c.adapt+=adaptation_jump;eligibility[i]*=std::exp(-dt*(*clock-eligibility_last[i])/tau_elig_ms);eligibility[i]+=1.;eligibility_last[i]=*clock;}}
     const float gap=-45.f-c.rest; const bool can_fire=c.v>-45.f || c.drive>gap || c.drive+c.g>gap;
     if(can_fire)active[kept++]=i;else c.flag=0;
   }
   *nactive=kept;
   double a1=now_ns(); int64_t aw0=awakened; touched.clear(); s_qlen+=queue_count[slot];
   for(int q=0;q<queue_count[slot];q++){
     const int i=queue[slot*n+q];
     if(modulation_mask[i]){
       for(int64_t e=ptr[i];e<ptr[i+1];e++){const int j=post[e];modulation[j]*=std::exp(-dt*(*clock-modulation_last[j])/100.f);modulation[j]+=std::abs(weight[e])/.275f;modulation_last[j]=*clock;s_mdel++;}
       continue;
     }
     for(int64_t e=ptr[i];e<ptr[i+1];e++){
       const int j=post[e];Cell& c=S[j];evolve(c,*clock,c.drive);s_del++;
       if(stamp[j]!=t){stamp[j]=t;hits[j]=0;touched.push_back(j);} hits[j]++;
       if(c.refr==0){c.g+=weight[e];awaken(j);}
     }
   }
   double a2=now_ns();
   queue_count[slot]=0;
   for(int q=0;q<queue_count[future];q++){const int i=queue[future*n+q];Cell& c=S[i];c.v=c.rest;c.g=0.f;c.refr=rfc;}
   double a3=now_ns();
   tp1+=a1-a0;tp2+=a2-a1;tp3+=a3-a2; s_wake+=awakened-aw0; s_touch+=touched.size(); s_ticks++;
   int mk=0; for(int j:touched){int k=hits[j];mk=std::max(mk,k); if(k>=2){s_multi_t++;s_multi_d+=k;}
     h[k==1?0:k<=4?1:k<=16?2:k<=64?3:k<=256?4:5]++;}
   s_maxk=std::max(s_maxk,(double)mk);
 }
 double a4=now_ns();
 for(int i=0;i<n;i++)evolve(S[i],*clock-1,S[i].drive);
 for(int i=0;i<n;i++){const Cell& c=S[i];last[i]=c.last;v[i]=c.v;g[i]=c.g;adaptation[i]=c.adapt;refractory[i]=c.refr;flags[i]=c.flag;}
 double a5=now_ns();
 stats[0]+=tp1;stats[1]+=tp2;stats[2]+=tp3;stats[3]+=(a5-a4);stats[4]+=(a5-T0);
 stats[5]+=s_active;stats[6]+=s_spk;stats[7]+=s_del;stats[8]+=s_mdel;stats[9]+=s_touch;stats[10]+=s_multi_t;stats[11]+=s_multi_d;
 stats[12]=std::max(stats[12],s_maxk);stats[13]+=s_wake;stats[14]+=s_qlen;stats[15]+=s_ticks;
 for(int b=0;b<6;b++)stats[16+b]+=h[b];
}

// revq_advance: fast_advance with ONE change -- each tick's spike queue is delivered in REVERSE
// order. Same model, same operations, only the float summation order into g (and the wake-up
// order) differ: what a GPU kernel with atomic float adds would give. test_metal.py --chaos uses
// it to show how far such an "equivalent" implementation drifts from the reference.
extern "C" void revq_advance(
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
 thread_local std::vector<Cell> cells; cells.resize(n); Cell* S=cells.data();
 for(int i=0;i<n;i++){Cell& c=S[i];c.last=last[i];c.v=v[i];c.g=g[i];c.adapt=adaptation[i];c.rest=rest[i];c.drive=drive[i];c.refr=refractory[i];c.flag=flags[i];c.kc=kc_mask[i];}
 auto evolve=[&](Cell& c,int64_t now,float current){
   int64_t d=now-c.last;if(d<=0)return;
   const int frozen=c.refr>0?c.refr-1:0; const int skip=(int)(d<frozen?d:frozen);
   if(skip>0 && c.adapt>0)c.adapt*=skip<1024?aa[skip]:std::exp(-dt*skip/adaptation_tau);
   c.refr=d>=c.refr?0:c.refr-d;d-=skip;
   if(d>0){const float a=d<1024?av[d]:std::exp(-dt*d/20.f),b=d<1024?ag[d]:std::exp(-dt*d/5.f);
     c.v=c.rest+(c.v-c.rest)*a+current*(1.f-a)+c.g*(a-b)/3.f;c.g*=b;
     if(c.adapt>0){const float cc=d<1024?aa[d]:std::exp(-dt*d/adaptation_tau);c.v-=c.adapt*adaptation_tau/(adaptation_tau-20.f)*(cc-a);c.adapt*=cc;}}
   c.last=now;
 };
 auto awaken=[&](int i){if(!S[i].flag){S[i].flag=1;active[(*nactive)++]=i;}};
 for(int i=0;i<n;i++)if(drive[i]!=previous_drive[i]){evolve(S[i],*clock-1,previous_drive[i]);previous_drive[i]=drive[i];awaken(i);}
 for(int t=0;t<steps;t++,(*clock)++){
   const int slot=*clock%slots,future=(*clock+delay)%slots;
   int kept=0,original=*nactive;
   for(int k=0;k<original;k++){
     const int i=active[k];Cell& c=S[i];evolve(c,*clock,c.drive);
     if(c.refr==0 && c.v>-45.f){queue[future*n+queue_count[future]++]=i;counts[i]++;
       if(c.kc){c.adapt+=adaptation_jump;eligibility[i]*=std::exp(-dt*(*clock-eligibility_last[i])/tau_elig_ms);eligibility[i]+=1.;eligibility_last[i]=*clock;}}
     const float gap=-45.f-c.rest; const bool can_fire=c.v>-45.f || c.drive>gap || c.drive+c.g>gap;
     if(can_fire)active[kept++]=i;else c.flag=0;
   }
   *nactive=kept;
   for(int q=queue_count[slot]-1;q>=0;q--){  // <- the only change: reverse delivery order
     const int i=queue[slot*n+q];
     if(modulation_mask[i]){
       for(int64_t e=ptr[i];e<ptr[i+1];e++){const int j=post[e];modulation[j]*=std::exp(-dt*(*clock-modulation_last[j])/100.f);modulation[j]+=std::abs(weight[e])/.275f;modulation_last[j]=*clock;}
       continue;
     }
     for(int64_t e=ptr[i];e<ptr[i+1];e++){const int j=post[e];Cell& c=S[j];evolve(c,*clock,c.drive);if(c.refr==0){c.g+=weight[e];awaken(j);}}
   }
   queue_count[slot]=0;
   for(int q=0;q<queue_count[future];q++){const int i=queue[future*n+q];Cell& c=S[i];c.v=c.rest;c.g=0.f;c.refr=rfc;}
 }
 for(int i=0;i<n;i++)evolve(S[i],*clock-1,S[i].drive);
 for(int i=0;i<n;i++){const Cell& c=S[i];last[i]=c.last;v[i]=c.v;g[i]=c.g;adaptation[i]=c.adapt;refractory[i]=c.refr;flags[i]=c.flag;}
}
